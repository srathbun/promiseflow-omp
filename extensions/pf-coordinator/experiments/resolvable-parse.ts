// The resolve layer: a pure, deterministic "detect ambiguity → apply a grammar
// extension → re-parse" loop (Path (i)). Expressible as a PromiseFlow work
// factory, because its identity is still segmentKey(grammar, prefix) — the
// extension is a deterministic function of the grammar, so two independent
// sessions reaching the same ambiguous prefix converge on the same computation.
//
// This is the single-agent hold-or-resolve loop from the M16 audit: the tool/loop
// holds at `decision` while the coordinator chooses the grammar update, then
// re-parses and returns the reduced forest.
import { stableHash } from "../promiseflow/keying.ts";
import type { ParseOnceResult } from "./marpa-client.ts";
import { AMBIGUOUS_EXPR_GRAMMAR, PRECEDENCE_EXPR_GRAMMAR } from "./grammars.ts";

export type ResolveStage = "unambiguous" | "resolved" | "unresolved";

/** The minimal parse surface the resolve layer needs (MarpaParseClient satisfies it). */
export interface ParseOnceClient {
  parseOnce(grammar: string, fragments: string[]): Promise<ParseOnceResult>;
}

export interface ResolveOutcome {
  stage: ResolveStage;
  /** Parse under the base grammar. */
  before: ParseOnceResult;
  /** Parse after the extension (=== before when not resolvable). */
  after: ParseOnceResult;
  /** The extension grammar applied, present only when stage === "resolved". */
  extendedGrammar?: string;
}

export interface ResolveOptions {
  /**
   * Deferral awaited between detecting ambiguity and applying the extension —
   * models the coordinator holding the turn while it decides how to update the
   * grammar. Optional (resolve runs straight through when omitted).
   */
  decision?: { promise: Promise<void> };
}

// Deterministic grammar → grammar' resolver, keyed by stableHash(grammar) so
// identical source always maps identically. Version this table WITH the
// coordinator (not the segment): a policy change should bump SEGMENT_SCHEME.
const RESOLVERS = new Map<string, (grammar: string) => string>();
RESOLVERS.set(stableHash(AMBIGUOUS_EXPR_GRAMMAR), () => PRECEDENCE_EXPR_GRAMMAR);

/** Return the disambiguating grammar for `grammar`, or null if none is known. */
export function resolveGrammar(grammar: string): string | null {
  const resolve = RESOLVERS.get(stableHash(grammar));
  return resolve ? resolve(grammar) : null;
}

/**
 * Parse `prefix` under `grammar`; if AMBIGUOUS and a resolver is registered,
 * await the (optional) decision, apply the extension, and re-parse.
 */
export async function resolvePrefix(
  client: ParseOnceClient,
  grammar: string,
  prefix: string[],
  options: ResolveOptions = {},
): Promise<ResolveOutcome> {
  const before = await client.parseOnce(grammar, prefix);
  if (before.status !== "AMBIGUOUS") {
    return { stage: "unambiguous", before, after: before };
  }
  const extended = resolveGrammar(grammar);
  if (extended === null) {
    // Ambiguity survives; nothing for this grammar can resolve it.
    return { stage: "unresolved", before, after: before };
  }
  if (options.decision) await options.decision.promise; // HOLD the turn
  const after = await client.parseOnce(extended, prefix);
  return { stage: "resolved", before, after, extendedGrammar: extended };
}