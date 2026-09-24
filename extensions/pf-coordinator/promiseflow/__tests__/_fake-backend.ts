/**
 * Port of `tests/_fake_backend.py`: deterministic in-memory `Backend` for
 * exercising RedisCoordinator logic without a Redis server.
 *
 * Every instance shares nothing; pass the SAME instance to multiple
 * coordinators to simulate processes sharing one backend. Lock TTL is modelled
 * with `performance.now()` (monotonic milliseconds) so stale-lock reclaim can
 * be tested without real timers.
 */
import type { Backend, Subscription } from "../backends.ts";

interface Queue {
	messages: string[];
	pending: { resolve: (r: IteratorResult<string>) => void } | undefined;
	closed: boolean;
}

export class FakeBackend implements Backend {
	private readonly locks = new Map<string, string>();
	private readonly lockExpiry = new Map<string, number>();
	private readonly payloads = new Map<string, unknown>();
	private readonly payloadExpiry = new Map<string, number>();
	private readonly results = new Map<string, unknown>();
	private readonly queues = new Map<string, Queue[]>();

	private now(): number {
		return performance.now();
	}

	private expireStale(): void {
		const now = this.now();
		for (const [key, at] of this.lockExpiry) {
			if (at <= now) {
				this.locks.delete(key);
				this.lockExpiry.delete(key);
			}
		}
	}

	// ---- LockBackend ----

	async acquire(key: string, token: string, ttl: number): Promise<boolean> {
		this.expireStale();
		if (this.locks.has(key)) return false;
		this.locks.set(key, token);
		this.lockExpiry.set(key, this.now() + ttl * 1000);
		return true;
	}

	async renew(key: string, token: string, ttl: number): Promise<boolean> {
		this.expireStale();
		if (this.locks.get(key) === token) {
			this.lockExpiry.set(key, this.now() + ttl * 1000);
			return true;
		}
		return false;
	}

	async release(key: string, token: string): Promise<void> {
		if (this.locks.get(key) === token) {
			this.locks.delete(key);
			this.lockExpiry.delete(key);
		}
	}

	async owner(key: string): Promise<string | null> {
		this.expireStale();
		return this.locks.get(key) ?? null;
	}

	// ---- PayloadStore ----

	async put(key: string, token: string, value: unknown, ttl?: number | null): Promise<void> {
		const id = `${key}\u0000${token}`;
		this.payloads.set(id, value);
		if (ttl !== undefined && ttl !== null) {
			this.payloadExpiry.set(id, this.now() + ttl * 1000);
		}
	}

	async take(key: string, token: string): Promise<unknown | null> {
		const id = `${key}\u0000${token}`;
		const expiry = this.payloadExpiry.get(id);
		if (expiry !== undefined && expiry <= this.now()) {
			this.payloads.delete(id);
			this.payloadExpiry.delete(id);
			return null;
		}
		return this.payloads.get(id) ?? null;
	}

	async discard(key: string, token: string): Promise<void> {
		const id = `${key}\u0000${token}`;
		this.payloads.delete(id);
		this.payloadExpiry.delete(id);
	}

	// ---- ResultStore ----

	async resultGet(key: string): Promise<unknown | null> {
		return this.results.get(key) ?? null;
	}

	async resultSet(key: string, value: unknown, _ttl?: number | null): Promise<void> {
		this.results.set(key, value);
	}

	async resultDelete(key: string): Promise<void> {
		this.results.delete(key);
	}

	async resultClear(): Promise<void> {
		this.results.clear();
	}

	// ---- MessageBus ----

	async publish(channel: string, message: string): Promise<void> {
		for (const queue of [...(this.queues.get(channel) ?? [])]) {
			queue.messages.push(message);
			queue.pending?.resolve({ value: message, done: false });
			queue.pending = undefined;
		}
	}

	subscribe(channel: string): Subscription {
		const queue: Queue = { messages: [], pending: undefined, closed: false };
		const list = this.queues.get(channel) ?? [];
		list.push(queue);
		this.queues.set(channel, list);

		const finish = (): IteratorResult<string> => {
			if (!queue.closed) {
				queue.closed = true;
				queue.pending?.resolve({ value: undefined, done: true });
				queue.pending = undefined;
				const remaining = this.queues.get(channel);
				if (remaining !== undefined) {
					const idx = remaining.indexOf(queue);
					if (idx >= 0) remaining.splice(idx, 1);
				}
			}
			return { value: undefined, done: true };
		};

		const iterator: Subscription = {
			next: () => {
				if (queue.closed) return Promise.resolve({ value: undefined, done: true });
				const message = queue.messages.shift();
				if (message !== undefined) return Promise.resolve({ value: message, done: false });
				return new Promise<IteratorResult<string>>((resolve) => {
					queue.pending = { resolve };
				});
			},
			return: () => Promise.resolve(finish()),
			throw: () => Promise.resolve(finish()),
			[Symbol.asyncIterator]() {
				return iterator;
			},
		};
		return iterator;
	}
}