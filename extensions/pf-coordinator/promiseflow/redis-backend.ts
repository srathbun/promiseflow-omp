/**
 * Port of `promiseflow/redis_backend.py`.
 *
 * Redis implementation of the lock / payload / result / pub-sub surfaces on
 * top of one ioredis client. Keys are namespaced so multiple applications can
 * share a Redis without colliding. Token-guarded renew and release run as Lua
 * so a late owner cannot clobber its successor.
 *
 * Deviation: Python defaults to a pickle codec; here the default is JSON
 * (`JsonCodec`). Results must therefore be JSON-serializable unless a custom
 * `Codec` is supplied.
 */
import type { Backend, Subscription } from "./backends.ts";

/** Serialize payload objects to/from an opaque string stored in Redis. */
export interface Codec {
	dumps(value: unknown): string;
	loads(data: string): unknown;
}

export class JsonCodec implements Codec {
	dumps(value: unknown): string {
		return JSON.stringify(value);
	}
	loads(data: string): unknown {
		return JSON.parse(data);
	}
}

/**
 * Structural subset of an ioredis `Redis` that `RedisBackend` needs. Satisfied
 * by `ioredis` and `ioredis-mock`; typed by call shape to sidestep the
 * overload sets. Non-subscriber connections need `duplicate()` so a dedicated
 * connection can enter subscriber mode.
 */
export interface RedisClientLike {
	set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<"OK" | null>;
	set(key: string, value: string, px: "PX", ms: number): Promise<"OK" | null>;
	set(key: string, value: string): Promise<"OK" | null>;
	get(key: string): Promise<string | null>;
	del(...keys: string[]): Promise<number>;
	eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
	scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[cursor: string, keys: string[]]>;
	publish(channel: string, message: string): Promise<number>;
	duplicate(): RedisClientLike;
	subscribe(channel: string): Promise<unknown>;
	unsubscribe(channel: string): Promise<unknown>;
	on(event: "message", listener: (channel: string, message: string) => void): unknown;
	off(event: "message", listener: (channel: string, message: string) => void): unknown;
	quit(): Promise<unknown>;
}

export interface RedisBackendOptions {
	/** Prefix for every key. Default `"promiseflow"`. */
	namespace?: string;
	/** Payload/result serialization. Default `JsonCodec`. */
	codec?: Codec;
}

const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
    return 0
end
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
`;

/** A subscription whose `ready` resolves once SUBSCRIBE has been acknowledged. */
export interface ReadySubscription extends Subscription {
	readonly ready: Promise<void>;
}

export class RedisBackend implements Backend {
	private readonly client: RedisClientLike;
	private readonly namespace: string;
	private readonly codec: Codec;

	constructor(client: RedisClientLike, options: RedisBackendOptions = {}) {
		this.client = client;
		this.namespace = options.namespace ?? "promiseflow";
		this.codec = options.codec ?? new JsonCodec();
	}

	private lockKey(key: string): string {
		return `${this.namespace}:lock:${key}`;
	}

	private payloadKey(key: string, token: string): string {
		return `${this.namespace}:payload:${key}:${token}`;
	}

	private resultKey(key: string): string {
		return `${this.namespace}:result:${key}`;
	}

	// ---- LockBackend -----

	async acquire(key: string, token: string, ttl: number): Promise<boolean> {
		const result = await this.client.set(this.lockKey(key), token, "PX", ttlMs(ttl), "NX");
		return result === "OK";
	}

	async renew(key: string, token: string, ttl: number): Promise<boolean> {
		const result = await this.client.eval(RENEW_LUA, 1, this.lockKey(key), token, String(ttlMs(ttl)));
		return Boolean(result);
	}

	async release(key: string, token: string): Promise<void> {
		await this.client.eval(RELEASE_LUA, 1, this.lockKey(key), token);
	}

	async owner(key: string): Promise<string | null> {
		return this.client.get(this.lockKey(key));
	}

	// ---- PayloadStore -----

	async put(key: string, token: string, value: unknown, ttl?: number | null): Promise<void> {
		const raw = this.codec.dumps(value);
		const payloadKey = this.payloadKey(key, token);
		if (ttl !== undefined && ttl !== null) {
			await this.client.set(payloadKey, raw, "PX", ttlMs(ttl));
		} else {
			await this.client.set(payloadKey, raw);
		}
	}

	async take(key: string, token: string): Promise<unknown | null> {
		const raw = await this.client.get(this.payloadKey(key, token));
		return raw === null ? null : this.codec.loads(raw);
	}

	async discard(key: string, token: string): Promise<void> {
		await this.client.del(this.payloadKey(key, token));
	}

	// ---- ResultStore -----

	async resultGet(key: string): Promise<unknown | null> {
		const raw = await this.client.get(this.resultKey(key));
		return raw === null ? null : this.codec.loads(raw);
	}

	async resultSet(key: string, value: unknown, ttl?: number | null): Promise<void> {
		const raw = this.codec.dumps(value);
		const resultKey = this.resultKey(key);
		if (ttl !== undefined && ttl !== null) {
			await this.client.set(resultKey, raw, "PX", ttlMs(ttl));
		} else {
			await this.client.set(resultKey, raw);
		}
	}

	async resultDelete(key: string): Promise<void> {
		await this.client.del(this.resultKey(key));
	}

	async resultClear(): Promise<void> {
		const pattern = `${this.namespace}:result:*`;
		let cursor = "0";
		do {
			const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
			if (keys.length > 0) await this.client.del(...keys);
			cursor = next;
		} while (cursor !== "0");
	}

	// ---- MessageBus -----

	async publish(channel: string, message: string): Promise<void> {
		await this.client.publish(channel, message);
	}

	/**
	 * Subscribe on a duplicated connection (subscriber mode is exclusive).
	 * Messages queue until consumed; `return()` unsubscribes and quits the
	 * duplicate, releasing any pending `next()`.
	 */
	subscribe(channel: string): ReadySubscription {
		const sub = this.client.duplicate();
		const queue: string[] = [];
		let pending: { resolve: (r: IteratorResult<string>) => void } | undefined;
		let done = false;

		const listener = (ch: string, message: string): void => {
			if (ch !== channel || done) return;
			if (pending !== undefined) {
				const { resolve } = pending;
				pending = undefined;
				resolve({ value: message, done: false });
			} else {
				queue.push(message);
			}
		};
		sub.on("message", listener);
		const ready = sub.subscribe(channel).then(() => undefined);
		ready.catch(() => {});

		const finish = async (): Promise<IteratorResult<string>> => {
			if (!done) {
				done = true;
				sub.off("message", listener);
				pending?.resolve({ value: undefined, done: true });
				pending = undefined;
				try {
					await sub.unsubscribe(channel);
				} catch {
					// connection may already be gone
				}
				try {
					await sub.quit();
				} catch {
					// connection may already be gone
				}
			}
			return { value: undefined, done: true };
		};

		const iterator: ReadySubscription = {
			ready,
			next: () => {
				if (done) return Promise.resolve({ value: undefined, done: true });
				const queued = queue.shift();
				if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
				return new Promise<IteratorResult<string>>((resolve) => {
					pending = { resolve };
				});
			},
			return: finish,
			throw: finish,
			[Symbol.asyncIterator]() {
				return iterator;
			},
		};
		return iterator;
	}
}

function ttlMs(ttl: number): number {
	return Math.max(1, Math.trunc(ttl * 1000));
}
