/** Port of `promiseflow/backends.py`. TTLs are SECONDS. */

/**
 * Distributed mutual exclusion for a unit of work. The lock value is the
 * owner's generation token; TTL expiry is the staleness mechanism.
 */
export interface LockBackend {
	/** Atomically take `key` for `token` if vacant; `true` on success. */
	acquire(key: string, token: string, ttl: number): Promise<boolean>;
	/** Extend the lock's expiry, only if still owned by `token`. */
	renew(key: string, token: string, ttl: number): Promise<boolean>;
	/** Delete the lock, only if owned by `token` (idempotent). */
	release(key: string, token: string): Promise<void>;
	/** Current owner token for `key`, or `null` if vacant. */
	owner(key: string): Promise<string | null>;
}

/** Volatile, generation-scoped hand-off of a completed result to followers. `take` is a non-destructive peek. */
export interface PayloadStore {
	put(key: string, token: string, value: unknown, ttl?: number | null): Promise<void>;
	take(key: string, token: string): Promise<unknown | null>;
	discard(key: string, token: string): Promise<void>;
}

/**
 * Retained-result storage (not generation-scoped).
 *
 * Python's protocol spells these `get/set/delete/clear`, but every real
 * implementation and consumer uses `result_get/...`; TS follows the used names.
 */
export interface ResultStore {
	resultGet(key: string): Promise<unknown | null>;
	resultSet(key: string, value: unknown, ttl?: number | null): Promise<void>;
	resultDelete(key: string): Promise<void>;
	resultClear(): Promise<void>;
}

/** A subscription: async-iterable stream of raw messages; `return()` unsubscribes. */
export type Subscription = AsyncIterableIterator<string>;

/** Lightweight completion announcements (pub/sub). */
export interface MessageBus {
	publish(channel: string, message: string): Promise<void>;
	subscribe(channel: string): Subscription;
}

/** Aggregate of every coordination surface a `RedisCoordinator` needs. */
export interface Backend extends LockBackend, PayloadStore, ResultStore, MessageBus {}
