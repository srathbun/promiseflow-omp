/** Port of `promiseflow/retry.py`. All delays are in SECONDS. */

export interface RetryPolicyOptions {
	maxAttempts?: number;
	baseDelay?: number;
	maxDelay?: number;
	multiplier?: number;
}

export class RetryPolicy {
	readonly maxAttempts: number;
	readonly baseDelay: number;
	readonly maxDelay: number;
	readonly multiplier: number;

	constructor(options: RetryPolicyOptions = {}) {
		this.maxAttempts = options.maxAttempts ?? 3;
		this.baseDelay = options.baseDelay ?? 0.1;
		this.maxDelay = options.maxDelay ?? 2.0;
		this.multiplier = options.multiplier ?? 2.0;
		if (this.maxAttempts <= 0) {
			throw new RangeError("maxAttempts must be > 0");
		}
	}

	/** Seconds to wait before `attemptNumber` (1-indexed). Attempt 1 never waits. */
	delayForAttempt(attemptNumber: number): number {
		if (attemptNumber <= 1) return 0;
		const delay = this.baseDelay * this.multiplier ** (attemptNumber - 2);
		return Math.min(delay, this.maxDelay);
	}

	async sleepBeforeAttempt(attemptNumber: number): Promise<void> {
		const delay = this.delayForAttempt(attemptNumber);
		if (delay > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
		}
	}
}
