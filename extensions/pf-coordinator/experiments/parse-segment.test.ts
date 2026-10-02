// Step-2 verification: the process-wide shared coordinator dedupes parse work
// across two independent callers (i.e., two subagents) via the segment key.
// Uses the REAL module-scoped singleton from parse-segment.ts (not a fresh
// coordinator per test), with delta assertions against its counters.
import { afterAll, expect, test } from "bun:test";
import { createDeferred } from "../promiseflow/index.ts";
import {
  DEFAULT_GRAMMAR,
  TYPED_GRAMMAR,
  coordinatedReason,
  dedupSavings,
  estimateTokens,
  grammarAuthoringCosts,
  parseSegment,
  reasonCounts,
  segmentStats,
  shutdownSegment,
} from "./parse-segment.ts";
import { segmentKey } from "./segment-key.ts";

afterAll(() => shutdownSegment());

test("stub grammar is genuinely ambiguous (vague, not mechanical)", async () => {
  const r = await parseSegment(DEFAULT_GRAMMAR, ["a b c"]);
  expect(r.parse.status).toBe("AMBIGUOUS");
  expect(r.parse.valueCount).toBe(4); // one, two, or three findings
  expect(r.parse.values.length).toBe(4);
});

test("two concurrent identical segments → one execution (shared coordinator)", async () => {
  const before = segmentStats();
  const fragments = ["session commit rollback"];
  const keyA = segmentKey({ version: 1, grammar: DEFAULT_GRAMMAR, fragments });
  const keyB = segmentKey({ version: 1, grammar: DEFAULT_GRAMMAR, fragments });
  expect(keyA).toBe(keyB);

  // Fire both callers in the same microtask flush so the follower joins while the
  // owner is still in-flight (parse_once is async I/O — the claim is deterministic).
  const gate = createDeferred<void>();
  const callA = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  const callB = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  gate.resolve();

  const [ra, rb] = await Promise.all([callA, callB]);
  const after = segmentStats();
  const delta = {
    requests: after.requests - before.requests,
    owners: after.owners - before.owners,
    followers: after.followers - before.followers,
    executions: after.executions - before.executions,
  };

  expect(delta.requests).toBe(2);
  expect(delta.executions).toBe(1); // the dedup claim
  expect(delta.owners).toBe(1);
  expect(delta.followers).toBe(1);
  expect(ra.key).toBe(rb.key);
  expect(ra.parse).toEqual(rb.parse);
  expect(ra.parse.valueCount).toBe(4);
});

test("different prefixes → different segments → no collapse", async () => {
  const before = segmentStats();
  const [r1, r2] = await Promise.all([
    parseSegment(DEFAULT_GRAMMAR, ["filter join"]),
    parseSegment(DEFAULT_GRAMMAR, ["a b c"]),
  ]);
  const after = segmentStats();

  expect(r1.key).not.toBe(r2.key);
  expect(after.executions - before.executions).toBe(2); // two distinct computations
});

test("dedup saves compute, not tokens (instrumentation is live)", async () => {
  const before = segmentStats();
  const fragments = ["DATETIME2", "Column"];
  const gate = createDeferred<void>();
  const pA = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  const pB = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  gate.resolve();
  await Promise.all([pA, pB]);
  const after = segmentStats();

  // compute dedup: 2 callers → 1 execution
  expect(after.executions - before.executions).toBe(1);
  // token spend is per-request: BOTH callers pay args + result tokens
  expect(after.argTokens - before.argTokens).toBeGreaterThan(0);
  expect(after.resultTokens - before.resultTokens).toBeGreaterThan(0);
  // and dedupSavings is explicit: token savings is zero today (compute-only)
  expect(dedupSavings().totalTokens).toBeGreaterThan(0);
  expect(dedupSavings().skippedTokens).toBe(0);
});

test("coordinatedReason: two concurrent same-state callers → one LLM call", async () => {
  const before = reasonCounts();
  const fragments = ["DATETIME2", "TIME", "Column"];
  let factoryCalls = 0;
  const generate = async (fs: string[]): Promise<string> => {
    factoryCalls += 1;
    return `root cause of ${fs.join(", ")}`;
  };

  const gate = createDeferred<void>();
  const pA = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, "What is the root cause?", generate));
  const pB = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, "What is the root cause?", generate));
  gate.resolve();
  const [ra, rb] = await Promise.all([pA, pB]);
  const after = reasonCounts();

  // 2 reason-requests, but the LLM-backed factory ran ONCE (the follower skipped it).
  expect(after.requests - before.requests).toBe(2);
  expect(after.llmCalls - before.llmCalls).toBe(1);
  expect(after.skippedLlmCalls - before.skippedLlmCalls).toBe(1);
  expect(factoryCalls).toBe(1);
  expect(ra.key).toBe(rb.key);
  expect(ra.output).toBe(rb.output);
});

test("coordinatedReason records REAL provider usage for the one owner turn", async () => {
  const before = reasonCounts();
  const fragments = ["DATETIME2"];
  const usage = { input: 120, output: 80 };
  const generate = async (): Promise<{ text: string; usage: { input: number; output: number } }> => ({
    text: "root cause",
    usage,
  });

  const gate = createDeferred<void>();
  const pA = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, "What is the root cause?", generate));
  const pB = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, "What is the root cause?", generate));
  gate.resolve();
  const [ra, rb] = await Promise.all([pA, pB]);
  const after = reasonCounts();

  // ONE LLM turn, whose (real) usage is recorded once — the follower skipped it.
  expect(after.llmCalls - before.llmCalls).toBe(1);
  expect(after.skippedLlmCalls - before.skippedLlmCalls).toBe(1);
  expect(after.inputTokens - before.inputTokens).toBe(usage.input);
  expect(after.outputTokens - before.outputTokens).toBe(usage.output);
  expect(ra.output).toBe(rb.output);
  // Tokens the follower was spared = the one skipped turn's real input+output.
  expect((after.skippedLlmCalls - before.skippedLlmCalls) * (usage.input + usage.output)).toBe(200);
});

test("coordinatedReason: same findings, different questions → distinct keys (no wrongful collapse)", async () => {
  const fragments = ["DATETIME2", "TIME", "Column"];
  const qRoot = "What is the root cause?";
  const qFix = "Propose a minimal fix.";
  const before = reasonCounts();
  let calls = 0;
  const generate = (label: string) => async (): Promise<string> => {
    calls += 1;
    return label;
  };

  const gate = createDeferred<void>();
  const pA = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, qRoot, generate("root")));
  const pB = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, qFix, generate("fix")));
  gate.resolve();
  const [ra, rb] = await Promise.all([pA, pB]);
  const after = reasonCounts();

  // Two DIFFERENT prompts at the same findings are different work: TWO LLM calls,
  // no follower. The prompt is part of the segment identity.
  expect(ra.key).not.toBe(rb.key);
  expect(after.llmCalls - before.llmCalls).toBe(2);
  expect(after.skippedLlmCalls - before.skippedLlmCalls).toBe(0);
  expect(calls).toBe(2);
  expect(ra.output).toBe("root");
  expect(rb.output).toBe("fix");
});

test("segmentKey: prompt participates in identity; parse segments omit it", () => {
  const grammar = DEFAULT_GRAMMAR;
  const fragments = ["a"];
  const noPrompt = segmentKey({ version: 1, grammar, fragments });
  const p1 = segmentKey({ version: 1, grammar, fragments, prompt: "root cause" });
  const p2 = segmentKey({ version: 1, grammar, fragments, prompt: "minimal fix" });
  // Parse identity is unchanged (no prompt in payload).
  expect(noPrompt).not.toBe(p1);
  // Different prompts → different identities.
  expect(p1).not.toBe(p2);
});

test("segmentKey: the grammar is part of identity — G1≠G2 means no dedup", () => {
  const fragments = ["DATETIME2", "TIME", "Column"];
  const kDefault = segmentKey({ version: 1, grammar: DEFAULT_GRAMMAR, fragments });
  const kTyped = segmentKey({ version: 1, grammar: TYPED_GRAMMAR, fragments });
  // Same fragments, different grammar source → different segment identities.
  expect(kDefault).not.toBe(kTyped);
  // Deterministic: identical grammar+input reproduces the same key.
  expect(segmentKey({ version: 1, grammar: TYPED_GRAMMAR, fragments })).toBe(kTyped);
});

test("coordinatedReason: same findings+prompt, different grammars → no collapse", async () => {
  const before = reasonCounts();
  const fragments = ["DATETIME2", "TIME", "Column"];
  const prompt = "What is the root cause?";
  let calls = 0;
  const generate = (label: string) => async (): Promise<string> => {
    calls += 1;
    return label;
  };

  const gate = createDeferred<void>();
  const pA = gate.promise.then(() => coordinatedReason(DEFAULT_GRAMMAR, fragments, prompt, generate("default")));
  const pB = gate.promise.then(() => coordinatedReason(TYPED_GRAMMAR, fragments, prompt, generate("typed")));
  gate.resolve();
  const [ra, rb] = await Promise.all([pA, pB]);
  const after = reasonCounts();

  // The grammar is in the key: two agents on the same findings+question but with
  // different grammars are NOT the same work — both run, no follower.
  expect(ra.key).not.toBe(rb.key);
  expect(after.llmCalls - before.llmCalls).toBe(2);
  expect(after.skippedLlmCalls - before.skippedLlmCalls).toBe(0);
  expect(calls).toBe(2);
});

test("grammar authoring: shipped grammars are free; a model-authored grammar is charged once", async () => {
  const before = grammarAuthoringCosts();

  // Shipped grammars are pre-authored in code — they cost the model nothing here.
  await parseSegment(DEFAULT_GRAMMAR, ["a b c"]);
  await parseSegment(TYPED_GRAMMAR, ["DATETIME2", "Column"]);
  expect(grammarAuthoringCosts().events).toBe(before.events);
  expect(grammarAuthoringCosts().tokens).toBe(before.tokens);

  // A grammar the model actually wrote (not one of the defaults) is a one-time
  // output-token cost, measured by the chars/4 heuristic.
  const authored = [
    ":default ::= action => ::array",
    ":start ::= doc",
    "doc ::= marker+",
    "marker ::= word",
    "word ~ [A-Za-z]+",
    ":discard ~ whitespace",
    "whitespace ~ [\\s]+",
  ].join("\n");

  const first = await parseSegment(authored, ["hello"]);
  const afterFirst = grammarAuthoringCosts();
  const expected = estimateTokens(authored);
  expect(afterFirst.events).toBe(before.events + 1);
  expect(afterFirst.tokens).toBe(before.tokens + expected);
  expect(first.grammarAuthorTokens).toBe(afterFirst.tokens);

  // Reusing the SAME authored grammar does not re-charge it (author once, share many).
  await parseSegment(authored, ["world"]);
  const afterSecond = grammarAuthoringCosts();
  expect(afterSecond.events).toBe(afterFirst.events);
  expect(afterSecond.tokens).toBe(afterFirst.tokens);

  // The derived savings view surfaces the one-time setup cost explicitly.
  expect(dedupSavings().grammarAuthorTokens).toBe(afterSecond.tokens);
});

test("coordinatedReason charges a model-authored grammar as a one-time authoring cost", async () => {
  const before = reasonCounts();
  const authored = [
    ":default ::= action => ::array",
    ":start ::= doc",
    "doc ::= word+",
    "word ~ [A-Za-z]+",
    ":discard ~ ws",
    "ws ~ [\\s]+",
  ].join("\n");
  const generate = async (): Promise<string> => "derived";

  const r = await coordinatedReason(authored, ["a"], "What next?", generate);
  const after = reasonCounts();

  expect(after.grammarAuthorTokens - before.grammarAuthorTokens).toBe(estimateTokens(authored));
  expect(r.grammarAuthorTokens).toBe(after.grammarAuthorTokens);
});