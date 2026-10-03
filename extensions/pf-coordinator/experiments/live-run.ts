// live-run.ts — run the long-horizon findings LIVE through the coordinator with a real
// local model (ollama), observing the dedup as it happens rather than replaying it.
//
//   bun extensions/pf-coordinator/experiments/live-run.ts
//
// Fires every one of the three fix agents' engaged symbols as a coordinatedReason
// continuation, all concurrently; the coordinator should run the real model once per
// DISTINCT symbol and skip the redundant engagements, and reasonCounts()/segmentTrace()
// report that live.
import { readFileSync } from "node:fs";
import {
  coordinatedReason,
  reasonCounts,
  segmentTrace,
  resetSegmentCoordinator,
  shutdownSegment,
  DEFAULT_GRAMMAR,
} from "./parse-segment.ts";

interface AgentResult {
  agent: string;
  turns: number;
  segments: string[];
  files: string[];
}

const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:4b";
const OLLAMA = "http://127.0.0.1:11434";

async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_predict: 24 } }),
  });
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

const agents = JSON.parse(readFileSync(new URL("./long-horizon-findings.json", import.meta.url), "utf8")) as AgentResult[];

const prompt = "In at most six words, what SQLAlchemy SQL Server reflection concern does this symbol name?";
const generate = async (fragments: string[]): Promise<string> => ollama(`Symbol: ${fragments.join(", ")}\n${prompt}`);

await resetSegmentCoordinator();

const requests = agents.flatMap((a) => a.segments.map((sym) => coordinatedReason(DEFAULT_GRAMMAR, [sym], prompt, generate)));
const started = Date.now();
await Promise.all(requests);
const elapsed = (Date.now() - started) / 1000;

const rc = reasonCounts();
const tr = segmentTrace();
console.log(`model: ${MODEL}`);
console.log(`requests ${rc.requests}  →  real model calls ${rc.llmCalls}  →  skipped ${rc.skippedLlmCalls}`);
console.log(`segmentTrace: total ${tr.total}, distinct ${tr.distinct}, collision ${(tr.collisionRate * 100).toFixed(0)}%`);
console.log(`histogram (occurrences→keys): ${JSON.stringify(tr.histogram)}`);
console.log(`elapsed ${elapsed.toFixed(1)}s`);

shutdownSegment();
process.exit(0);