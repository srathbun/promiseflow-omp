/**
 * Port of `promiseflow/redis_coordinator.py`.
 *
 * Distributed single-flight coordinator backed by a shared `Backend`. Mirrors
 * `Coordinator`'s observable contract across processes: one owner per key
 * performs the work, followers elsewhere join the same generation and receive
 * the result without recomputing, and dead owners are reclaimed via lock
 * expiry (TTL) instead of polling.
 *
 * Deviation: Python's `RedisCoordinator.get_or_run` has no per-call
 * `retention`; here it is honored so `AdvancedChain` cache points work
 * distributed as the README promises.
 */
import type { Backend, Subscription } from "./backends.ts";
import { awaitWithTimeout } from "./coordinator.ts";
import { createDeferred, type Deferred } from "./entry.ts";
import { RetryExhaustedError, WorkerStaleError, WorkTimeoutError } from "./exceptions.ts";
import { Hooks } from "./observability.ts";
import { Ephemeral, type RetentionPolicy } from "./retention.ts";
import { RetryPolicy } from "./retry.ts";
import type { CoordinatorLike, GetOrRunOptions, WorkFactory } from "./types.ts";

export interface RedisCoordinatorOptions {
	/** Pub/sub channel for BUILT/FAILED frames. Default `"promiseflow"`. */
	channel?: string;
	retention?: RetentionPolicy;
	/** Lock TTL in seconds; a dead owner's lock expires after this. Default 10. */
	staleAfter?: number;
	/** Seconds between lock renewals. Default 1. */
	heartbeatInterval?: number;
	/** Seconds a generation-scoped transport payload lingers. Default 60. */
	payloadTtl?: number;
	hooks?: Hooks;
}

const BUILT = "BUILT";
const FAILED = "FAILED";

/** Returned by the follower path when the caller should retry the claim. */
const RETRY: unique symbol = Symbol("RETRY");
/** Returned by the retention fast path when no usable retained value exists. */
const MISS: unique symbol = Symbol("MISS");

/** Retained results are stored as `[value, createdSeconds]` (wall clock, cross-process). */
type Envelope = [value: unknown, created: number];

function isEnvelope(value: unknown): value is Envelope {
	return Array.isArray(value) && value.length === 2 && typeof value[1] === "number";
}

function encode(event: string, key: string, token: string): string {
	return JSON.stringify({ event, key, token });
}

function decode(raw: string): { event: string; key: string; token: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	if (!("event" in parsed) || !("key" in parsed) || !("token" in parsed)) return undefined;
	const { event, key, token } = parsed;
	if (typeof event !== "string" || typeof key !== "string" || typeof token !== "string") return undefined;
	return { event, key, token };
}

export class RedisCoordinator<T = unknown> implements CoordinatorLike, AsyncDisposable {
	private readonly backend: Backend;
	private readonly channel: string;
	private readonly retention: RetentionPolicy;
	private readonly staleAfter: number;
	private readonly heartbeatInterval: number;
	private readonly payloadTtl: number;
	private readonly hooks: Hooks;
	private readonly waiters = new Map<string, Deferred<string>[]>();
	private readonly refreshing = new Set<string>();
	private subscription: Subscription | undefined;
	private listener: Promise<void> | undefined;
	private closed = false;

	constructor(backend: Backend, options: RedisCoordinatorOptions = {}) {
		this.backend = backend;
		this.channel = options.channel ?? "promiseflow";
		this.retention = options.retention ?? new Ephemeral();
		this.staleAfter = options.staleAfter ?? 10;
		this.heartbeatInterval = options.heartbeatInterval ?? 1;
		this.payloadTtl = options.payloadTtl ?? 60;
		this.hooks = options.hooks ?? new Hooks();
	}

	/** Subscribe to the wake channel and start the listener. Resolves once the subscription is live. */
	async start(): Promise<void> {
		if (this.listener !== undefined) return;
		this.closed = false;
		const subscription = this.backend.subscribe(this.channel);
		this.subscription = subscription;
		if ("ready" in subscription && subscription.ready instanceof Promise) {
			await subscription.ready;
		}
		this.listener = this.listen(subscription);
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.subscription !== undefined) {
			await this.subscription.return?.();
		}
		if (this.listener !== undefined) {
			await this.listener;
			this.listener = undefined;
		}
		this.subscription = undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	/** Drop any retained result for `key`; the next call recomputes. */
	async invalidate(key: string): Promise<void> {
		await this.backend.resultDelete(key);
	}

	/** Drop all retained results. */
	async clear(): Promise<void> {
		await this.backend.resultClear();
	}

	/** Run `workFactory` once per key across processes, sharing the result. */
	async getOrRun<R = T>(key: string, workFactory: WorkFactory<R>, options: GetOrRunOptions = {}): Promise<R> {
		const retry = options.retry ?? new RetryPolicy();
		const hb = options.heartbeatInterval ?? this.heartbeatInterval;
		const retention = options.retention ?? this.retention;

		if (retention.retain) {
			const result = await this.retentionFastpath(key, workFactory, retry, hb, options.timeout, retention);
			if (result !== MISS) return result as R;
		}
		return this.build(key, workFactory, retry, hb, options.timeout, retention);
	}

	private async build<R>(
		key: string,
		workFactory: WorkFactory<R>,
		retry: RetryPolicy,
		hb: number,
		timeout: number | undefined,
		retention: RetentionPolicy,
	): Promise<R> {
		let lastError: unknown;

		for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
			await retry.sleepBeforeAttempt(attempt);
			if (attempt > 1) await this.hooks.emit("onRetry", key, attempt);
			const token = crypto.randomUUID().replaceAll("-", "");

			if (await this.backend.acquire(key, token, this.staleAfter)) {
				await this.hooks.emit("onOwner", key);
				const heartbeat = this.startHeartbeat(key, token, hb);
				const timeoutError = new WorkTimeoutError(`work for key=${JSON.stringify(key)} exceeded timeout`);
				try {
					const started = performance.now();
					let result: R;
					try {
						result = await awaitWithTimeout(Promise.resolve().then(workFactory), timeout, timeoutError);
					} catch (error) {
						await this.finishFailure(key, token);
						lastError = error;
						await this.hooks.emit("onError", key, error);
						if (error === timeoutError && attempt === retry.maxAttempts) throw error;
						continue;
					}
					const elapsed = (performance.now() - started) / 1000;
					await this.finishSuccess(key, token, result);
					if (retention.retain) {
						await this.backend.resultSet(key, [result, Date.now() / 1000] satisfies Envelope);
					}
					await this.hooks.emit("onSuccess", key, elapsed);
					return result;
				} finally {
					heartbeat.stop();
				}
			}

			await this.hooks.emit("onFollower", key);
			const result = await this.runFollower(key, timeout);
			if (result !== RETRY) return result as R;
			lastError = new WorkerStaleError(`owner failed or vanished for key=${JSON.stringify(key)}`);
		}

		throw new RetryExhaustedError(`retries exhausted for key=${JSON.stringify(key)}`, { cause: lastError });
	}

	private async retentionFastpath<R>(
		key: string,
		workFactory: WorkFactory<R>,
		retry: RetryPolicy,
		hb: number,
		timeout: number | undefined,
		retention: RetentionPolicy,
	): Promise<unknown | typeof MISS> {
		const env = await this.backend.resultGet(key);
		if (!isEnvelope(env)) return MISS;
		const [value, created] = env;
		const lifetime = retention.lifetime;
		if (lifetime !== null && Date.now() / 1000 - created >= lifetime) {
			if (retention.staleWhileRevalidate) {
				if (!this.refreshing.has(key)) {
					this.refreshing.add(key);
					this.build(key, workFactory, retry, hb, timeout, retention)
						.catch(() => {})
						.finally(() => this.refreshing.delete(key));
				}
				await this.hooks.emit("onCacheHit", key);
				return value;
			}
			await this.backend.resultDelete(key);
			return MISS;
		}
		await this.hooks.emit("onCacheHit", key);
		return value;
	}

	// ---- owner path ----

	/** Payload first (authoritative), then wake followers, then release. */
	private async finishSuccess(key: string, token: string, result: unknown): Promise<void> {
		await this.backend.put(key, token, result, this.payloadTtl);
		await this.backend.publish(this.channel, encode(BUILT, key, token));
		await this.backend.release(key, token);
	}

	private async finishFailure(key: string, token: string): Promise<void> {
		await this.backend.publish(this.channel, encode(FAILED, key, token));
		await this.backend.release(key, token);
	}

	private startHeartbeat(key: string, token: string, intervalSeconds: number): { stop: () => void } {
		let stopped = false;
		let timer: Timer | undefined;
		let wake: (() => void) | undefined;
		const loop = async (): Promise<void> => {
			while (!stopped) {
				await new Promise<void>((resolve) => {
					wake = resolve;
					timer = setTimeout(resolve, intervalSeconds * 1000);
				});
				if (stopped) return;
				const ok = await this.backend.renew(key, token, this.staleAfter);
				if (!ok) return;
			}
		};
		loop().catch(() => {});
		return {
			stop: () => {
				stopped = true;
				if (timer !== undefined) clearTimeout(timer);
				wake?.();
			},
		};
	}

	// ---- follower path ----

	private async runFollower(key: string, timeout: number | undefined): Promise<unknown | typeof RETRY> {
		const ownerToken = await this.backend.owner(key);
		if (ownerToken === null) return RETRY;

		const waiterKey = `${key}\u0000${ownerToken}`;
		const waiter = createDeferred<string>();
		let list = this.waiters.get(waiterKey);
		if (list === undefined) {
			list = [];
			this.waiters.set(waiterKey, list);
		}
		list.push(waiter);

		// Bound one wait slice; re-check liveness on each expiry so a crashed
		// owner (whose lock eventually expires) does not strand followers.
		const sliceTimeout = timeout ?? this.staleAfter;
		const sliceError = new WorkTimeoutError(`follower wait slice for key=${JSON.stringify(key)} expired`);

		try {
			while (true) {
				// The payload is authoritative and may already be published; reads
				// are non-destructive so every follower sees the result. As in
				// Python, a legitimately-null result is indistinguishable from
				// "not yet published".
				const payload = await this.backend.take(key, ownerToken);
				if (payload !== null) return payload;

				let event: string;
				try {
					event = await awaitWithTimeout(waiter.promise, sliceTimeout, sliceError);
				} catch (error) {
					if (error !== sliceError) throw error;
					if ((await this.backend.owner(key)) !== ownerToken) return RETRY;
					continue;
				}

				if (event === FAILED) return RETRY;
				// BUILT: loop back and fetch the payload.
			}
		} finally {
			const remaining = this.waiters.get(waiterKey);
			if (remaining !== undefined) {
				const idx = remaining.indexOf(waiter);
				if (idx >= 0) remaining.splice(idx, 1);
				if (remaining.length === 0) this.waiters.delete(waiterKey);
			}
		}
	}

	// ---- listener ----

	private async listen(subscription: Subscription): Promise<void> {
		try {
			for await (const raw of subscription) {
				if (this.closed) return;
				const frame = decode(raw);
				if (frame === undefined) continue;
				const waiters = this.waiters.get(`${frame.key}\u0000${frame.token}`);
				if (waiters === undefined) continue;
				this.waiters.delete(`${frame.key}\u0000${frame.token}`);
				for (const waiter of waiters) {
					if (!waiter.settled) waiter.resolve(frame.event);
				}
			}
		} catch {
			// subscription torn down
		}
	}
}
