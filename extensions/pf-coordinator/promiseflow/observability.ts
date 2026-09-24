/** Port of `promiseflow/observability.py`. Handlers may be sync or async. */

export type HookHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

export interface HookHandlers {
	onOwner?: HookHandler<[key: string]>;
	onFollower?: HookHandler<[key: string]>;
	onCacheHit?: HookHandler<[key: string]>;
	onSuccess?: HookHandler<[key: string, elapsed: number]>;
	onError?: HookHandler<[key: string, error: unknown]>;
	onStale?: HookHandler<[key: string]>;
	onRetry?: HookHandler<[key: string, attempt: number]>;
}

export type HookName = keyof HookHandlers;

type HookArgs<N extends HookName> = NonNullable<HookHandlers[N]> extends HookHandler<infer A> ? A : never;

/**
 * Optional lifecycle callbacks a coordinator invokes at key events.
 *
 * `onSuccess(key, elapsed)` reports elapsed SECONDS (faithful to Python).
 */
export class Hooks implements HookHandlers {
	onOwner?: HookHandler<[key: string]>;
	onFollower?: HookHandler<[key: string]>;
	onCacheHit?: HookHandler<[key: string]>;
	onSuccess?: HookHandler<[key: string, elapsed: number]>;
	onError?: HookHandler<[key: string, error: unknown]>;
	onStale?: HookHandler<[key: string]>;
	onRetry?: HookHandler<[key: string, attempt: number]>;

	constructor(handlers: HookHandlers = {}) {
		Object.assign(this, handlers);
	}

	async emit<N extends HookName>(name: N, ...args: HookArgs<N>): Promise<void> {
		const handler = this[name] as HookHandler<HookArgs<N>> | undefined;
		if (handler === undefined) return;
		await handler(...args);
	}
}
