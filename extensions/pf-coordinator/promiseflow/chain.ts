/**
 * Port of `promiseflow/chain.py`.
 *
 * Composable pipeline of named async steps, deduplicated via a coordinator.
 * Each segment key is `stableHash([initial, orderedStepNames, callableFingerprints])`
 * — the *initial* input plus the path so far. Concurrent callers sharing the
 * same initial value and the same prefix of (name, callable) execute each shared
 * segment exactly once. Two distinct functions sharing a name do not alias.
 *
 * Completed segment results follow the coordinator's retention policy
 * (ephemeral by default): a later run recomputes rather than reusing.
 */
import { callableFingerprint, stableHash } from "./keying.ts";
import { RetryPolicy } from "./retry.ts";
import type { CoordinatorLike, StepFn } from "./types.ts";

/** Chain segments do not retry by default so step errors surface immediately. */
const CHAIN_DEFAULT_RETRY = new RetryPolicy({ maxAttempts: 1 });

export interface ChainRunOptions {
	/** Forwarded to `getOrRun` for every segment. Default: single attempt. */
	retry?: RetryPolicy;
}

export interface ChainStep {
	readonly name: string;
	readonly fn: StepFn;
}

export class Chain<T = unknown> {
	private readonly stepList: ChainStep[] = [];

	constructor(readonly coordinator: CoordinatorLike) {}

	/** Registered steps, in order (read-only view). */
	get steps(): readonly ChainStep[] {
		return this.stepList;
	}

	/** Append a named step. Returns `this` for fluent chaining. */
	add(stepName: string, step: StepFn<never, unknown>): this {
		this.stepList.push({ name: stepName, fn: step });
		return this;
	}

	/** Execute the chain, deduplicating each segment through the coordinator. */
	async run<R = T>(initial?: unknown, options: ChainRunOptions = {}): Promise<R> {
		const retry = options.retry ?? CHAIN_DEFAULT_RETRY;
		let value: unknown = initial;
		const segmentPath: string[] = [];
		const fingerprints: string[] = [];

		for (const { name, fn } of this.stepList) {
			segmentPath.push(name);
			fingerprints.push(callableFingerprint(fn));
			const key = stableHash([initial, segmentPath, fingerprints]);
			const input = value;
			// Chain steps are dynamically typed: each receives the previous
			// segment's runtime value, so invoke the erased shape.
			const step = fn as (input: unknown) => unknown;
			value = await this.coordinator.getOrRun(key, () => step(input), { retry });
		}

		return value as R;
	}
}