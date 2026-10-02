// redis-segment-demo.ts — prove a completed segment is cached in Redis and reused by
// a later "process", using the Redis running on this machine.
//
//   bun extensions/pf-coordinator/experiments/redis-segment-demo.ts
//
// Three calls at the same per-step key:
//   1. owner — runs the Marpa parse and caches the result in Redis;
//   2. same coordinator, sequential — retention cache hit (no re-execution);
//   3. fresh coordinator against the same Redis (simulating another process) — cache hit
//      with zero executions, because the value persisted in Redis.
import { DEFAULT_GRAMMAR, parseSegment, resetSegmentCoordinator, shutdownSegment } from "./parse-segment.ts";

process.env.PF_REDIS_URL = process.env.PF_REDIS_URL ?? "redis://127.0.0.1:6379";
process.env.SEGMENT_TTL_SECONDS = process.env.SEGMENT_TTL_SECONDS ?? "60";

const step = "DATETIME2";

async function main(): Promise<void> {
  const r1 = await parseSegment(DEFAULT_GRAMMAR, [step]);
  console.log(`call 1 (owner)         : executions=${r1.stats.executions} cacheHits=${r1.stats.cacheHits} parse=${r1.parse.status}`);

  const r2 = await parseSegment(DEFAULT_GRAMMAR, [step]);
  console.log(`call 2 (same process)  : executions=${r2.stats.executions} cacheHits=${r2.stats.cacheHits}`);

  // Close this coordinator and build a fresh one against the same Redis — the
  // equivalent of a different process coming back later.
  await resetSegmentCoordinator();

  const r3 = await parseSegment(DEFAULT_GRAMMAR, [step]);
  console.log(`call 3 (fresh process) : executions=${r3.stats.executions} cacheHits=${r3.stats.cacheHits}`);

  shutdownSegment();
  process.exit(0);
}

await main();