// integrated-loop.ts — the complete loop, live, in one process: grammar authoring
// (create → parse → AMBIGUOUS → model writes a refined grammar → extend → reparse) fused
// with the coordinator (single-flight + TTL + real model) keyed on the REFINED grammar, with
// trace. This is the authoring loop and the coordination loop operating together for the first
// time, rather than as separate tiers.
//
//   bun extensions/pf-coordinator/experiments/integrated-loop.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GRAMMAR,
  TYPED_GRAMMAR,
  coordinatedReason,
  reasonCounts,
  segmentTrace,
  resetSegmentCoordinator,
  shutdownSegment,
} from "./parse-segment.ts";
import { MarpaStateClient, type MarpaOutcome } from "./marpa-state-client.ts";

const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:4b";
const OLLAMA = "http://127.0.0.1:11434";

async function ollama(prompt: string, numPredict = 24): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_predict: numPredict } }),
  });
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

interface AgentResult {
  agent: string;
  segments: string[];
}

const TEMPORAL = ["DATETIME", "DATETIME2", "DATETIMEOFFSET", "SMALLDATETIME", "TIME"];

async function main(): Promise<void> {
  const worker = new MarpaStateClient();

  // 1) Authoring — loose grammar, then the model refines it live.
  const stateId = await worker.create(DEFAULT_GRAMMAR);
  for (const t of TEMPORAL) await worker.add(stateId, t);
  const loose = await worker.parse(stateId);
  console.log(`[authoring] v1 loose grammar: ${loose.status} — ${loose.valueCount} readings over ${TEMPORAL.length} temporal tokens`);

  const refinedRaw = await ollama(
    `You are tightening a Marpa SLIF grammar. It is currently:\n${DEFAULT_GRAMMAR}\n` +
    `It over-groups a flat finding list: parsing the tokens ${TEMPORAL.join(", ")} reports ${loose.valueCount} readings of pure regroupings.\n` +
    `Write a refined SLIF grammar that types SQL temporal literals (DATETIME2, DATETIMEOFFSET, TIME, SMALLDATETIME, DATETIME) separately from generic markers, so a temporal token is a single typed alternative. ` +
    `Return ONLY the SLIF grammar text.`,
    256,
  );

  let refinedGrammar = refinedRaw.trim();
  if (refinedGrammar.length === 0) refinedGrammar = TYPED_GRAMMAR;

  let refined: MarpaOutcome;
  try {
    refined = await worker.extend(stateId, refinedGrammar);
  } catch (e) {
    console.log(`[authoring] model grammar rejected (${e instanceof Error ? e.message : e}); falling back to TYPED_GRAMMAR`);
    refinedGrammar = TYPED_GRAMMAR;
    refined = await worker.extend(stateId, TYPED_GRAMMAR);
  }
  console.log(`[authoring] v2 refined grammar: ${refined.status} — ${refined.valueCount} readings (grammar_version ${refined.grammarVersion})`);
  console.log(`[authoring] model grammar accepted: ${refinedGrammar === TYPED_GRAMMAR ? "no (fallback)" : "yes"}`);

  // 2) Coordination — keyed on the REFINED grammar, live.
  await resetSegmentCoordinator();
  const agents = JSON.parse(readFileSync(new URL("./long-horizon-findings.json", import.meta.url), "utf8")) as AgentResult[];
  const prompt = "In at most six words, what SQLAlchemy SQL Server reflection concern does this symbol name?";
  const generate = async (f: string[]): Promise<string> => ollama(`Symbol: ${f.join(", ")}\n${prompt}`);

  const requests = agents.flatMap((a) => a.segments.map((sym) => coordinatedReason(refinedGrammar, [sym], prompt, generate)));
  const started = Date.now();
  await Promise.all(requests);
  const elapsed = (Date.now() - started) / 1000;

  const rc = reasonCounts();
  const tr = segmentTrace();
  console.log(`[coordination] keyed on grammar v${refined.grammarVersion}: requests=${rc.requests} real_model_calls=${rc.llmCalls} skipped=${rc.skippedLlmCalls} collision=${(tr.collisionRate * 100).toFixed(0)}% in ${elapsed.toFixed(0)}s`);

  worker.terminate();
  shutdownSegment();
  process.exit(0);
}

await main();