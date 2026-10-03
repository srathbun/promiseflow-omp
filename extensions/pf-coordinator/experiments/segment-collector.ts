// segment-collector.ts — the live side of the loop. A long-lived process that tails
// `segment-emissions.log`, routes every emitted symbol through `coordinatedReason` with a
// real local model, and prints the running trace as the fix agents work. Because it is the
// single coordinator, re-engagement of the same symbol by a later agent is a TTL cache hit —
// dedup observed live, not replayed.
//
//   SEGMENT_TTL_SECONDS=1200 bun extensions/pf-coordinator/experiments/segment-collector.ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  coordinatedReason,
  reasonCounts,
  segmentTrace,
  resetSegmentCoordinator,
  shutdownSegment,
  DEFAULT_GRAMMAR,
} from "./parse-segment.ts";

const LOG = fileURLToPath(new URL("./segment-emissions.log", import.meta.url));
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:4b";

// Long-enough TTL that a symbol engaged early by one agent is still cached when another
// agent reaches it minutes later.
process.env.SEGMENT_TTL_SECONDS = process.env.SEGMENT_TTL_SECONDS ?? "1200";

async function ollama(prompt: string): Promise<string> {
  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_predict: 20 } }),
  });
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

const prompt = "In at most six words, what SQLAlchemy SQL Server reflection concern does this symbol name?";
const generate = (fragments: string[]): Promise<string> => ollama(`Symbol: ${fragments.join(", ")}\n${prompt}`);

await resetSegmentCoordinator();

let processed = 0;
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    if (!existsSync(LOG)) return;
    const lines = readFileSync(LOG, "utf8").split(/\r?\n/).filter((s) => s.trim().length > 0);
    const fresh = lines.slice(processed);
    if (fresh.length === 0) return;
    processed = lines.length;
    await Promise.all(fresh.map((sym) => coordinatedReason(DEFAULT_GRAMMAR, [sym.trim()], prompt, generate)));
    const rc = reasonCounts();
    const tr = segmentTrace();
    console.log(
      `[live] requests=${rc.requests} real_model_calls=${rc.llmCalls} skipped=${rc.skippedLlmCalls} distinct=${tr.distinct}/${tr.total} collision=${(tr.collisionRate * 100).toFixed(0)}%`,
    );
  } finally {
    draining = false;
  }
}

await drain();
console.log(`collector ready: watching ${LOG} (model ${MODEL}, TTL ${process.env.SEGMENT_TTL_SECONDS}s)`);
const timer = setInterval(() => drain().catch((e) => console.error("[collector]", e.message)), 250);

const shutdown = async (): Promise<void> => {
  clearInterval(timer);
  await drain();
  shutdownSegment();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());