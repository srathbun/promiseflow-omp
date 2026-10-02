// savings-model.ts — the "is it worth it" math: how many continuations must converge
// before the dedup saving clears the grammar/schema authoring cost.
//
// The one nontrivial input is `convergence`: the fraction of redundantly-done work
// whose agents produce the identical segment key. W1 measured ~0 under a loose schema
// (whole-turn collision 0.00) — convergence is the gate, not the token arithmetic. The
// point of this model is to show that *given* convergence, the economics are trivial:
// it costs one avoided continuation to pay for a modest grammar.

export interface SavingsInput {
  /** Tokens a single avoided continuation saves (the fresh input + output the follower would re-spend). */
  costPerContinuation: number;
  /** One-time tokens spent authoring the grammar + schema (the setup this system moves onto the model). */
  authoringTokens: number;
  /** Number of work-units done by more than one agent (the redundant, shareable units). */
  redundantUnits: number;
  /** Average extra agents redundantly re-doing each such unit (a unit has 1 + this many agents). */
  extraAgentsPerUnit: number;
  /** 0..1 — fraction of those redundant groups whose findings byte-converge to one key. */
  convergence: number;
}

export interface SavingsOutput {
  /** Redundant re-doings actually skipped (deduplicated). */
  avoidedContinuations: number;
  /** Tokens saved by those avoided continuations. */
  grossSavedTokens: number;
  /** Gross saving minus the one-time authoring cost. */
  netTokens: number;
  /** Avoided-continuation count at which net turns ≥ 0. */
  breakEvenContinuations: number;
  worthIt: boolean;
}

export function continuationSavings(i: SavingsInput): SavingsOutput {
  const avoided = i.redundantUnits * i.extraAgentsPerUnit * i.convergence;
  const gross = avoided * i.costPerContinuation;
  const net = gross - i.authoringTokens;
  const breakEven = i.costPerContinuation === 0 ? Number.POSITIVE_INFINITY : i.authoringTokens / i.costPerContinuation;
  return {
    avoidedContinuations: avoided,
    grossSavedTokens: gross,
    netTokens: net,
    breakEvenContinuations: breakEven,
    worthIt: net > 0,
  };
}