/** Port of `promiseflow/exceptions.py`. */

export class ParallelPromisesError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** Raised when the owner's heartbeat lapses and the sweeper reclaims its work. */
export class WorkerStaleError extends ParallelPromisesError {}

/** Raised when a unit of work exceeds its explicit `timeout`. */
export class WorkTimeoutError extends ParallelPromisesError {}

/** Raised when every attempt of a `RetryPolicy` has failed; `cause` is the last error. */
export class RetryExhaustedError extends ParallelPromisesError {}
