/** Port of `promiseflow/entry.py`: one in-flight unit of work. */

export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
	readonly settled: boolean;
}

/** A promise with externally-exposed settle functions and a synchronous `settled` flag. */
export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	let settled = false;
	const promise = new Promise<T>((res, rej) => {
		resolve = (v) => {
			settled = true;
			res(v);
		};
		reject = (e) => {
			settled = true;
			rej(e);
		};
	});
	// Internal coordination promises may reject with no external awaiter when
	// ownership rolls over; consume so the runtime never reports it unhandled.
	promise.catch(() => {});
	return {
		promise,
		resolve,
		reject,
		get settled() {
			return settled;
		},
	};
}

export class WorkEntry<T> {
	readonly future: Deferred<T>;
	readonly ownerToken: object;
	/** `performance.now()` milliseconds of the last owner heartbeat. */
	lastHeartbeat: number;

	constructor(future: Deferred<T>, ownerToken: object, lastHeartbeat: number = performance.now()) {
		this.future = future;
		this.ownerToken = ownerToken;
		this.lastHeartbeat = lastHeartbeat;
	}
}
