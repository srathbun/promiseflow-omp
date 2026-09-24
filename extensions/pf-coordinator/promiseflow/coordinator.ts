/**
 * Port of `promiseflow/coordinator.py`.
 *
 * In-process single-flight coordinator for async workloads. For a given key,
 * only one owner performs work while all followers await the same shared
 * future. Completed results are governed by a `RetentionPolicy` (`Ephemeral`
 * by default): retained results are reused by later callers instead of
 * recomputing.
 *
 * Python guards `_entries` / `_results` / `_refreshing` with `asyncio.Lock`.
 * JS is single-threaded, so the equivalent invariant is that every
 * read-modify-write of those maps happens in a synchronous section with no
 * `await` between the read and the write. Methods marked "sync section" below
 * rely on that.
 */
import { createDeferred, WorkEntry } from "./entry.ts";
import { RetryExhaustedError, WorkerStaleError, WorkTimeoutError } from "./exceptions.ts";
import { Hooks } from "./observability.ts";
import { Ephemeral, type RetentionPolicy } from "./retention.ts";
import { RetryPolicy } from "./retry.ts";
import type { CoordinatorLike, GetOrRunOptions, WorkFactory } from "./types.ts";

export interface CoordinatorOptions {
	/** Seconds without a heartbeat before the sweeper reclaims an owner. Default 10. */
	staleAfter?: number;
	/** Seconds between sweeper passes. Default 1. */
	sweepInterval?: number;
	retention?: RetentionPolicy;
	hooks?: Hooks;
}

interface StoredResult {
	value: unknown;
	/** `performance.now()` ms at store time. */
	created: number;
}

type Lookup = { status: "miss" } | { status: "hit" | "stale"; value: unknown };

/** A cancellable sleep: `promise` resolves after `ms` or immediately on `cancel()`. */
interface Sleep {
	promise: Promise<void>;
	cancel: () => void;
}

function sleep(ms: number): Sleep {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let wake!: () => void;
	const promise = new Promise<void>((resolve) => {
		wake = resolve;
		timer = setTimeout(resolve, ms);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	});
	return {
		promise,
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
			wake();
		},
	};
}

/**
 * Race `promise` against `timeoutSeconds`; rejects with `timeoutError`.
 * The timer is always cleared. Unlike Python's `wait_for`, the underlying work
 * keeps running after a timeout (JS cannot cancel a promise); its eventual
 * rejection is consumed so it never surfaces as unhandled.
 */
export async function awaitWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number | undefined, timeoutError: Error): Promise<T> {
	if (timeoutSeconds === undefined) return promise;
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(timeoutError), timeoutSeconds * 1000);
	});
	promise.catch(() => {});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export class Coordinator<T = unknown> implements CoordinatorLike, AsyncDisposable {
	private readonly entries = new Map<string, WorkEntry<unknown>>();
	private readonly results = new Map<string, StoredResult>();
	private readonly refreshing = new Set<string>();
	private readonly staleAfter: number;
	private readonly sweepInterval: number;
	private readonly retention: RetentionPolicy;
	private readonly hooks: Hooks;
	private sweeper: Promise<void> | undefined;
	private sweeperSleep: Sleep | undefined;
	private closed = false;

	constructor(options: CoordinatorOptions = {}) {
		this.staleAfter = options.staleAfter ?? 10;
		this.sweepInterval = options.sweepInterval ?? 1;
		this.retention = options.retention ?? new Ephemeral();
		this.hooks = options.hooks ?? new Hooks();
	}

	/** Start the stale-worker sweeper. Idempotent. */
	async start(): Promise<void> {
		if (this.sweeper === undefined) {
			this.closed = false;
			this.sweeper = this.runSweeper();
		}
	}

	/** Stop the sweeper. In-flight work is not interrupted. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.sweeper !== undefined) {
			this.sweeperSleep?.cancel();
			await this.sweeper;
			this.sweeper = undefined;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	/** Drop any retained result for `key`; the next call recomputes. */
	invalidate(key: string): void {
		this.results.delete(key);
	}

	/** Drop all retained results. */
	clear(): void {
		this.results.clear();
	}

	/** @internal test seam: keys with unsettled in-flight entries. */
	inflightKeys(): string[] {
		const keys: string[] = [];
		for (const [key, entry] of this.entries) {
			if (!entry.future.settled) keys.push(key);
		}
		return keys;
	}

	/** @internal test seam */
	hasRetained(key: string): boolean {
		return this.results.has(key);
	}

	/** @internal test seam */
	retainedCount(): number {
		return this.results.size;
	}

	/**
	 * Get the shared result for `key`, running `workFactory` if this caller
	 * becomes owner. `options.retention` overrides the coordinator's default
	 * policy for this call.
	 */
	getOrRun<R = T>(key: string, workFactory: WorkFactory<R>, options: GetOrRunOptions = {}): Promise<R> {
		return this.run(key, workFactory, {
			retry: options.retry ?? new RetryPolicy(),
			timeout: options.timeout,
			heartbeatInterval: options.heartbeatInterval ?? 1,
			useCache: true,
			retention: options.retention ?? this.retention,
		});
	}

	private async run<R>(
		key: string,
		workFactory: WorkFactory<R>,
		params: {
			retry: RetryPolicy;
			timeout: number | undefined;
			heartbeatInterval: number;
			useCache: boolean;
			retention: RetentionPolicy;
		},
	): Promise<R> {
		const { retry, timeout, heartbeatInterval, useCache, retention } = params;
		let lastError: unknown;

		for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
			await retry.sleepBeforeAttempt(attempt);
			if (attempt > 1) await this.hooks.emit("onRetry", key, attempt);

			if (useCache) {
				// sync section: lookup + refresh-slot claim
				const lookup = this.retentionLookup(key, retention);
				const shouldRefresh = lookup.status === "stale" && this.markRefreshing(key);
				if (lookup.status === "hit") {
					await this.hooks.emit("onCacheHit", key);
					return lookup.value as R;
				}
				if (lookup.status === "stale") {
					if (shouldRefresh) {
						this.spawnRefresh(key, workFactory, { retry, timeout, heartbeatInterval, retention });
					}
					await this.hooks.emit("onCacheHit", key);
					return lookup.value as R;
				}
			}

			const token = {};
			const { entry, isOwner } = this.claimOrJoin(key, token);
			const timeoutError = new WorkTimeoutError(`work for key=${JSON.stringify(key)} exceeded timeout`);
			if (!isOwner) {
				await this.hooks.emit("onFollower", key);
				try {
					return (await awaitWithTimeout(entry.future.promise, timeout, timeoutError)) as R;
				} catch (error) {
					// The follower's own timeout is final; any other rejection
					// (WorkerStaleError, owner failure) re-enters the claim loop.
					if (error === timeoutError) throw error;
					lastError = error;
					continue;
				}
			}

			await this.hooks.emit("onOwner", key);
			const heartbeat = this.startHeartbeat(key, token, heartbeatInterval);
			try {
				const started = performance.now();
				const result = await awaitWithTimeout(Promise.resolve().then(workFactory), timeout, timeoutError);
				const elapsed = (performance.now() - started) / 1000;
				this.resolveIfOwner(key, token, result, retention);
				await this.hooks.emit("onSuccess", key, elapsed);
				return result;
			} catch (error) {
				this.rejectIfOwner(key, token, error);
				await this.hooks.emit("onError", key, error);
				lastError = error;
				if (error instanceof WorkTimeoutError && attempt === retry.maxAttempts) throw error;
			} finally {
				heartbeat.stop();
			}
		}

		throw new RetryExhaustedError(`retries exhausted for key=${JSON.stringify(key)}`, { cause: lastError });
	}

	/** sync section */
	private retentionLookup(key: string, retention: RetentionPolicy): Lookup {
		if (!retention.retain) return { status: "miss" };
		const stored = this.results.get(key);
		if (stored === undefined) return { status: "miss" };
		const lifetime = retention.lifetime;
		if (lifetime !== null && (performance.now() - stored.created) / 1000 >= lifetime) {
			if (retention.staleWhileRevalidate) return { status: "stale", value: stored.value };
			this.results.delete(key);
			return { status: "miss" };
		}
		return { status: "hit", value: stored.value };
	}

	/** sync section: claim the background-refresh slot for `key`; true if we won it. */
	private markRefreshing(key: string): boolean {
		if (this.refreshing.has(key)) return false;
		this.refreshing.add(key);
		return true;
	}

	private spawnRefresh<R>(
		key: string,
		workFactory: WorkFactory<R>,
		params: { retry: RetryPolicy; timeout: number | undefined; heartbeatInterval: number; retention: RetentionPolicy },
	): void {
		this.run(key, workFactory, { ...params, useCache: false })
			.catch(() => {})
			.finally(() => this.refreshing.delete(key));
	}

	/** sync section */
	private claimOrJoin(key: string, ownerToken: object): { entry: WorkEntry<unknown>; isOwner: boolean } {
		const current = this.entries.get(key);
		if (current === undefined || current.future.settled) {
			const entry = new WorkEntry<unknown>(createDeferred<unknown>(), ownerToken);
			this.entries.set(key, entry);
			return { entry, isOwner: true };
		}
		return { entry: current, isOwner: false };
	}

	/** sync section */
	private resolveIfOwner(key: string, ownerToken: object, result: unknown, retention: RetentionPolicy): void {
		const entry = this.entries.get(key);
		if (entry === undefined || entry.ownerToken !== ownerToken) return;
		if (!entry.future.settled) entry.future.resolve(result);
		this.entries.delete(key);
		if (retention.retain) {
			this.results.set(key, { value: result, created: performance.now() });
		}
	}

	/** sync section */
	private rejectIfOwner(key: string, ownerToken: object, error: unknown): void {
		const entry = this.entries.get(key);
		if (entry === undefined || entry.ownerToken !== ownerToken) return;
		if (!entry.future.settled) entry.future.reject(error);
		this.entries.delete(key);
	}

	private startHeartbeat(key: string, ownerToken: object, intervalSeconds: number): { stop: () => void } {
		let stopped = false;
		let current: Sleep | undefined;
		const loop = async (): Promise<void> => {
			while (!stopped) {
				current = sleep(intervalSeconds * 1000);
				await current.promise;
				if (stopped) return;
				// sync section
				const entry = this.entries.get(key);
				if (entry === undefined || entry.ownerToken !== ownerToken || entry.future.settled) return;
				entry.lastHeartbeat = performance.now();
			}
		};
		loop().catch(() => {});
		return {
			stop: () => {
				stopped = true;
				current?.cancel();
			},
		};
	}

	private async runSweeper(): Promise<void> {
		while (!this.closed) {
			this.sweeperSleep = sleep(this.sweepInterval * 1000);
			await this.sweeperSleep.promise;
			if (this.closed) return;
			const cutoff = performance.now() - this.staleAfter * 1000;
			// sync section
			const reclaimed: string[] = [];
			for (const [key, entry] of this.entries) {
				if (!entry.future.settled && entry.lastHeartbeat < cutoff) {
					this.entries.delete(key);
					entry.future.reject(new WorkerStaleError(`worker stale for key=${JSON.stringify(key)}`));
					reclaimed.push(key);
				}
			}
			for (const key of reclaimed) {
				try {
					await this.hooks.emit("onStale", key);
				} catch {
					// a throwing hook must not kill the sweeper
				}
			}
		}
	}
}
