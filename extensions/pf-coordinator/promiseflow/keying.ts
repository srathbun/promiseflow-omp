/**
 * Port of `promiseflow/keying.py`.
 *
 * `stableHash` mirrors Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)`:
 * object keys are sorted recursively, arrays keep order, and values JSON
 * cannot express (functions, symbols, bigint, undefined) fall back to
 * `String(value)`.
 */
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : String(value);
		case "undefined":
		case "function":
		case "symbol":
		case "bigint":
			return String(value);
		case "object":
			break;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Map) {
		return canonicalize(Object.fromEntries(value));
	}
	if (value instanceof Set) return canonicalize([...value]);
	if (typeof value !== "object") return String(value);
	if ("toJSON" in value && typeof value.toJSON === "function") {
		return canonicalize(value.toJSON());
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		out[key] = canonicalize(item);
	}
	return out;
}

/** Canonical compact JSON text with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/** Deterministic sha256 hex digest of the canonical JSON encoding of `value`. */
export function stableHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Stable identity for a callable, used to disambiguate same-named chain steps.
 *
 * Python folds `module.qualname#sha256(co_code)`. JS has no bytecode access, so
 * this folds `fn.name#sha256(Function.prototype.toString())`: identical source
 * text yields identical fingerprints (stable across processes); distinct source
 * yields distinct fingerprints. Like Python's `co_code`, captured closure values
 * are NOT part of the identity.
 */
// biome-ignore lint/complexity/noBannedTypes: any callable
export function callableFingerprint(fn: Function): string {
	const name = fn.name || "<anonymous>";
	const digest = createHash("sha256").update(Function.prototype.toString.call(fn), "utf8").digest("hex");
	return `${name}#${digest}`;
}
