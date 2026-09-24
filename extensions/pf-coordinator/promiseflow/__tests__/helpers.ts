/**
 * Shared test helpers.
 *
 * These tests exercise a time-based coordination library (heartbeats, stale
 * sweeps, TTL lifetimes, stale-while-revalidate refresh). The semantics under
 * test ARE wall-clock timing, so deterministic fake timers cannot drive them:
 * `Coordinator`/`RedisCoordinator` measure elapsed time with `performance.now()`
 * and drive their loops with real `setTimeout`. The Python suite these port
 * likewise uses real `asyncio.sleep`. Delays are therefore real, kept as short
 * as the asserted thresholds allow.
 */

/** Resolve after `ms` milliseconds (real timer — see header). */
export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * ioredis-mock isolates data by `host:port/db`; distinct `db` numbers get
 * distinct in-process stores. A shared counter keeps every test's store
 * separate (and avoids the process-global `db:0` default).
 */
let dbCounter = 1;
export function nextRedisDb(): number {
	return dbCounter++;
}

/** Resolve once `predicate` turns truthy, polling every `stepMs` up to `timeoutMs`. */
export async function until(predicate: () => boolean, timeoutMs = 2_000, stepMs = 5): Promise<void> {
	const start = performance.now();
	while (!predicate()) {
		if (performance.now() - start > timeoutMs) {
			throw new Error("until() timed out");
		}
		await sleep(stepMs);
	}
}