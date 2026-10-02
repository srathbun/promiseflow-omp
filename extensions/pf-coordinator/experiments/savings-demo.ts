// savings-demo.ts — run the "is it worth it" numbers.
//
//   bun extensions/pf-coordinator/experiments/savings-demo.ts
//
// Continuation token costs are the paper's measured figures: ~1,315 tokens of fresh
// work (521 uncached input + 794 output) over a ~16.6k cached prefix — so the cache-
// inclusive continuation is ~16,700 tokens. The honest marginal saving of dedup over
// prefix-caching alone is the fresh 1,315; the 16,700 is the full continuation a
// follower would otherwise pay. Authoring is the one-time grammar+schema the model
// writes (a grammar is a few hundred chars; the schema + a couple trials, more).
import { continuationSavings } from "./savings-model.ts";

const C = { fresh: 1315, cacheInclusive: 16700 };
const A = { cheap: 200, moderate: 1000, expensive: 5000 };

console.log("=== Break-even: avoided continuations needed to pay the authoring cost ===");
console.log(`continuation tokens           fresh ${C.fresh}     cache-inclusive ${C.cacheInclusive}`);
for (const [name, authoring] of Object.entries(A)) {
  const row = Object.entries(C)
    .map(([, c]) => continuationSavings({ costPerContinuation: c, authoringTokens: authoring, redundantUnits: 1, extraAgentsPerUnit: 1, convergence: 1 }).breakEvenContinuations.toFixed(2))
    .join("        ");
  console.log(`authoring ${String(authoring).padStart(5)} tokens      ${row}`);
}

console.log("\n=== Net tokens by workload shape (C = cache-inclusive 16,700, A = 1,000) ===");
const scenarios: Array<[string, number, number, number]> = [
  ["loose schema — W1: convergence ~0", 10, 1, 0],
  ["tight schema — 10 units, 1 extra agent", 10, 1, 1],
  ["tight schema — 20 units, 2 extra agents, 50% converge", 20, 2, 0.5],
  ["tight schema — 100 units, 2 extra agents", 100, 2, 1],
];
for (const [label, units, extra, convergence] of scenarios) {
  const out = continuationSavings({ costPerContinuation: C.cacheInclusive, authoringTokens: A.moderate, redundantUnits: units, extraAgentsPerUnit: extra, convergence });
  const avoided = out.avoidedContinuations.toFixed(0).padStart(4);
  console.log(`${label.padEnd(46)} avoided=${avoided}  net=${out.netTokens.toLocaleString()}`);
}

console.log("\nReading: the economics are cheap *given convergence* — one avoided continuation");
console.log("pays a modest grammar several times over. The gate is convergence, not cost:");
console.log("W1's loose schema made it 0.00 (pure loss); a tight shared schema is what turns");
console.log("redundant same-unit work into the + sign. Latency (a skipped model round-trip) is");
console.log("an additional, unmodeled saving on top of the tokens.");