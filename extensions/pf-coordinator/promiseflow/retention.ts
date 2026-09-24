/**
 * Port of `promiseflow/retention.py`.
 *
 * Governs how long a completed result outlives its in-flight waiters.
 * `lifetime` is in SECONDS (faithful to Python); `null` means no expiry.
 */
export interface RetentionPolicy {
	/** Keep completed results for reuse (`true`) or drop once waiters drain (`false`). */
	readonly retain: boolean;
	/** Seconds a retained result stays reusable; `null` = manual invalidation only. */
	readonly lifetime: number | null;
	/** Serve an expired value immediately and refresh in the background. */
	readonly staleWhileRevalidate: boolean;
}

function assertLifetime(lifetime: number): void {
	if (!(lifetime > 0)) {
		throw new RangeError("lifetime must be > 0");
	}
}

/** Drop completed results once the current waiter set drains (default). */
export class Ephemeral implements RetentionPolicy {
	readonly retain = false;
	readonly lifetime = null;
	readonly staleWhileRevalidate = false;
}

/** Retain completed results until explicitly invalidated. */
export class Manual implements RetentionPolicy {
	readonly retain = true;
	readonly lifetime = null;
	readonly staleWhileRevalidate = false;
}

/** Retain completed results for `lifetime` seconds, then rebuild. */
export class Ttl implements RetentionPolicy {
	readonly retain = true;
	readonly staleWhileRevalidate = false;
	readonly lifetime: number;
	constructor(lifetime: number) {
		assertLifetime(lifetime);
		this.lifetime = lifetime;
	}
}

/** Serve an expired result immediately while refreshing it in the background. */
export class StaleWhileRevalidate implements RetentionPolicy {
	readonly retain = true;
	readonly staleWhileRevalidate = true;
	readonly lifetime: number;
	constructor(lifetime: number) {
		assertLifetime(lifetime);
		this.lifetime = lifetime;
	}
}
