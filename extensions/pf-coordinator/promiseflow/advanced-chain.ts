/**
 * Port of `promiseflow/advanced_chain.py`.
 *
 * Advanced chain semantics from "Parallel Processing with Promises":
 *
 * - **Cache points (S4)** — only steps marked `isCachePoint` retain their result
 *   for reuse across flights; every other step is ephemeral (single-flight
 *   within a flight, then recomputed).
 * - **Cascade rebuild (S5)** — each segment key folds in the *forwarded value*
 *   of the previous segment, not merely the step path. When an upstream retained
 *   result is invalidated and recomputes to a different value, every downstream
 *   key changes and recomputes; an unchanged value preserves downstream reuse.
 * - **Uncached tail (S6)** — steps marked `uncachedTail` always run ephemerally,
 *   forming a fresh tail after a shared cached prefix.
 */
import { callableFingerprint, stableHash } from "./keying.ts";
import { Ephemeral, type RetentionPolicy, Ttl } from "./retention.ts";
import type { CoordinatorLike, StepFn } from "./types.ts";

/** How aggressively chain segments are retained. */
export enum CachePointMode {
	/** Only steps marked `isCachePoint` retain results; the rest are ephemeral. */
	CACHE_POINTS_ONLY = "cache_points_only",
	/** Every step retains its result (except steps marked `uncachedTail`). */
	FULL_CHAIN = "full_chain",
}

export interface AdvancedStepOptions {
	/** Retain this step's result under `cachePointRetention` (S4). */
	isCachePoint?: boolean;
	/** Force this step ephemeral regardless of mode (S6). */
	uncachedTail?: boolean;
}

export interface AdvancedChainOptions {
	cachePointMode?: CachePointMode;
	/** Retention for cache points. Default `Ttl(3600)`. */
	cachePointRetention?: RetentionPolicy;
	enableUncachedTail?: boolean;
}

export interface AdvancedStep {
	readonly name: string;
	readonly fn: StepFn;
	readonly isCachePoint: boolean;
	readonly uncachedTail: boolean;
}

export interface CacheStatus {
	totalSteps: number;
	cachePoints: number;
	uncachedTailSteps: number;
	cachePointMode: string;
	uncachedTailEnabled: boolean;
}

export class AdvancedChain<T = unknown> {
	readonly cachePointMode: CachePointMode;
	readonly cachePointRetention: RetentionPolicy;
	readonly enableUncachedTail: boolean;
	private readonly stepList: AdvancedStep[] = [];

	constructor(
		readonly coordinator: CoordinatorLike,
		options: AdvancedChainOptions = {},
	) {
		this.cachePointMode = options.cachePointMode ?? CachePointMode.CACHE_POINTS_ONLY;
		this.cachePointRetention = options.cachePointRetention ?? new Ttl(3600);
		this.enableUncachedTail = options.enableUncachedTail ?? true;
	}

	/** Registered steps, in order (read-only view). */
	get steps(): readonly AdvancedStep[] {
		return this.stepList;
	}

	/** Append a step. Returns `this` for fluent chaining. */
	add(stepName: string, step: StepFn<never, unknown>, options: AdvancedStepOptions = {}): this {
		this.stepList.push({
			name: stepName,
			fn: step,
			isCachePoint: options.isCachePoint ?? false,
			uncachedTail: options.uncachedTail ?? false,
		});
		return this;
	}

	private retentionFor(step: AdvancedStep): RetentionPolicy {
		if (step.uncachedTail && this.enableUncachedTail) return new Ephemeral();
		if (this.cachePointMode === CachePointMode.FULL_CHAIN) return this.cachePointRetention;
		if (step.isCachePoint) return this.cachePointRetention;
		return new Ephemeral();
	}

	/**
	 * Execute the chain. Each segment key folds in the forwarded value of the
	 * previous segment, so an upstream recompute to a new value cascades to a
	 * downstream rebuild while an unchanged value reuses downstream entries.
	 */
	async run<R = T>(initial?: unknown): Promise<R> {
		let value: unknown = initial;
		const segmentPath: string[] = [];
		const fingerprints: string[] = [];

		for (const step of this.stepList) {
			segmentPath.push(step.name);
			fingerprints.push(callableFingerprint(step.fn));
			const key = stableHash([value, segmentPath, fingerprints]);
			const retention = this.retentionFor(step);
			const input = value;
			// Chain steps are dynamically typed: invoke the erased shape.
			const fn = step.fn as (input: unknown) => unknown;
			value = await this.coordinator.getOrRun(key, () => fn(input), { retention });
		}

		return value as R;
	}

	/** Summarize how this chain is configured. */
	cacheStatus(): CacheStatus {
		return {
			totalSteps: this.stepList.length,
			cachePoints: this.stepList.filter((s) => s.isCachePoint).length,
			uncachedTailSteps: this.stepList.filter((s) => s.uncachedTail).length,
			cachePointMode: this.cachePointMode,
			uncachedTailEnabled: this.enableUncachedTail,
		};
	}

	toString(): string {
		const cachePoints = this.stepList.filter((s) => s.isCachePoint).length;
		return `AdvancedChain(steps=${this.stepList.length}, cachePoints=${cachePoints}, mode=${this.cachePointMode})`;
	}
}

/** An `AdvancedChain` defaulting to cache-points-only retention. */
export function createCachePointsOnlyChain(coordinator: CoordinatorLike): AdvancedChain {
	return new AdvancedChain(coordinator, { cachePointMode: CachePointMode.CACHE_POINTS_ONLY });
}

/** An `AdvancedChain` that retains every step (except tail steps). */
export function createFullChain(coordinator: CoordinatorLike): AdvancedChain {
	return new AdvancedChain(coordinator, { cachePointMode: CachePointMode.FULL_CHAIN });
}
