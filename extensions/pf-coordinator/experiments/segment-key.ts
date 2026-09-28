// Segment identity layer: the deterministic identity of a parser computation.
//
// A "segment" is the computation  parse_once(grammar, [fragment 1 .. n]).
// Its key is derivable strictly from the KNOWN inputs (grammar + ordered
// prefix) BEFORE the parse runs — never from the parse result or forest — so
// two independent sessions reaching the same prefix converge on the same key
// and can hand the computation to a single-flight coordinator.
//
// The exact encoding is a documented, versioned namespace so that changing the
// grammar or the canonicalization scheme can never silently collide with old
// segment identities.
import { stableHash } from "../promiseflow/keying.ts";

/** Versioned identity-scheme namespace. Bump to invalidate every prior segment. */
export const SEGMENT_SCHEME = "aristotle-turn/v1";

export interface SegmentKeyInput {
  /** Aristotle grammar version (e.g. 1 for the dangling-else grammar). */
  version: number;
  /** Full grammar source text (SLIF). */
  grammar: string;
  /** Ordered fragment prefix: fragment[1], fragment[2], ..., fragment[n]. */
  fragments: string[];
  /**
   * The derivation goal (question/prompt) for LLM-continuation segments. Two
   * agents at the same `(grammar, fragments)` but different prompts are doing
   * different work and must NOT share a key — the prompt is part of the
   * identity. Parse-only segments omit it.
   */
  prompt?: string;
  /** Identity-scheme namespace; defaults to the parse-segment scheme. */
  scheme?: string;
}

/**
 * `"aristotle-turn/v1#<sha256>"`, where `<sha256>` = `stableHash` of the
 * canonical JSON `{ scheme, version, grammar, fragments }` (plus `prompt` when
 * present). `stableHash` recursively sorts object keys and preserves array
 * order, so the fragment ORDER is part of the identity.
 */
export function segmentKey(input: SegmentKeyInput): string {
  const scheme = input.scheme ?? SEGMENT_SCHEME;
  const payload: Record<string, unknown> = {
    scheme,
    version: input.version,
    grammar: input.grammar,
    fragments: input.fragments,
  };
  if (input.prompt !== undefined) payload.prompt = input.prompt;
  return `${scheme}#${stableHash(payload)}`;
}