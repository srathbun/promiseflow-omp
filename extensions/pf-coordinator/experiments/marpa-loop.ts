// marpa-loop.ts — close the long-horizon caveat: prove the engaged-symbol convergence
// materializes as REAL segment-key dedup through the Marpa worker + coordinator + TTL
// cache, and show the loop's ambiguity→refinement move on the shared temporal core.
//
//   bun extensions/pf-coordinator/experiments/marpa-loop.ts
import { readFileSync } from "node:fs";
import {
  DEFAULT_GRAMMAR,
  TYPED_GRAMMAR,
  parseSegment,
  parseSegmentSteps,
  segmentTrace,
  dedupSavings,
  resetSegmentCoordinator,
  shutdownSegment,
} from "./parse-segment.ts";

interface AgentResult {
  agent: string;
  turns: number;
  segments: string[];
  files: string[];
}

const agents = JSON.parse(readFileSync(new URL("./long-horizon-findings.json", import.meta.url), "utf8")) as AgentResult[];

const TEMPORAL_CORE = ["DATETIME", "DATETIME2", "DATETIMEOFFSET", "SMALLDATETIME", "TIME"];

async function main(): Promise<void> {
  // 1) the loop: loose grammar over-groups, refined grammar bounds — the shared core.
  const loose = await parseSegment(DEFAULT_GRAMMAR, TEMPORAL_CORE);
  const refined = await parseSegment(TYPED_GRAMMAR, TEMPORAL_CORE);
  console.log("Loop — ambiguity → refinement (shared temporal core, 5 tokens)");
  console.log(`  loose    doc ::= finding+  : ${loose.parse.status} — ${loose.parse.valueCount} interpretations`);
  console.log(`  refined  temporal | marker : ${refined.parse.status} — ${refined.parse.valueCount} interpretations (expected 2^5 = 32)`);

  await resetSegmentCoordinator();

  // 2) real segment keys: feed each agent's engaged symbols SEQUENTIALLY, so a later
  // agent re-engaging an earlier agent's symbol is a TTL cache hit.
  for (const a of agents) {
    await parseSegmentSteps(TYPED_GRAMMAR, a.segments);
  }

  const trace = segmentTrace();
  const ds = dedupSavings();
  const totalEngagements = agents.reduce((n, a) => n + a.segments.length, 0);

  console.log("\nConvergence → real segment keys (coordinator + Marpa + TTL");
  console.log(`  engagements ${totalEngagements} → distinct keys ${trace.distinct}  (collision ${(trace.collisionRate * 100).toFixed(0)}%)`);
  console.log(`  occurrences histogram: ${JSON.stringify(trace.histogram)}`);
  console.log(`  executions (distinct work): ${ds.executions}`);
  console.log(`  cache hits (later agent reused): ${ds.cacheHits}  in-flight followers: ${ds.followers}`);

  const avoided = totalEngagements - trace.distinct;
  const fresh = avoided * 1315;
  const inclusive = avoided * 16700;
  console.log("\nSavings (if each redundant unit gates an LLM continuation)");
  console.log(`  redundant units: ${avoided} of ${totalEngagements}`);
  console.log(`  gross tokens: fresh ${fresh.toLocaleString()}  / cache-inclusive ${inclusive.toLocaleString()}  (net of ~1,000 authoring)`);

  shutdownSegment();
  process.exit(0);
}

await main();