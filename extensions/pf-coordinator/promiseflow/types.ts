/** Port of `promiseflow/types.py` plus the structural coordinator contract chains consume. */
import type { RetentionPolicy } from "./retention.ts";
import type { RetryPolicy } from "./retry.ts";

/** Produces the unit of work; invoked only by the owner. */
export type WorkFactory<T> = () => Promise<T> | T;

/**
 * One chain step: receives the previous segment's value.
 *
 * `In` defaults to `never` (not `unknown`) so any single-argument function —
 * including `(v: number) => number` — is assignable, matching Python's untyped
 * pipeline. The value actually passed at runtime is the previous segment's
 * output; consumers annotate `In` on their step function, not on the chain.
 */
export type StepFn<In = never, Out = unknown> = (input: In) => Promise<Out> | Out;

/** Options shared by `Coordinator.getOrRun` and `RedisCoordinator.getOrRun`. All times in SECONDS. */
export interface GetOrRunOptions {
	/** Explicit work timeout; distinct from stale reclaim. */
	timeout?: number;
	retry?: RetryPolicy;
	heartbeatInterval?: number;
	/** Per-call override of the coordinator's retention policy. */
	retention?: RetentionPolicy;
}

/** What `Chain` / `AdvancedChain` require: satisfied by both `Coordinator` and `RedisCoordinator`. */
export interface CoordinatorLike {
	getOrRun<T>(key: string, workFactory: WorkFactory<T>, options?: GetOrRunOptions): Promise<T>;
}
