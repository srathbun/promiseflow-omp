// sqlalchemy-scenarios.ts — real SQLAlchemy problem-states plus a ledger harness.
//
// Each scenario bundles a grammar + a deterministic ordered finding set derived
// from a real SQLAlchemy issue, so N concurrent "agents" at the same state can be
// run through BOTH coordinated steps:
//   parseSegment   → dedup crosses Marpa compute (forest, 0 tokens saved)
//   coordinatedReason → dedup crosses an LLM continuation (tokens saved)
import {
  estimateTokens,
  parseSegment,
  coordinatedReason,
  segmentStats,
  reasonCounts,
  TYPED_GRAMMAR,
} from "./parse-segment.ts";

export interface Scenario {
  name: string;
  grammar: string;
  findings: string[];
  question: string;
}

/** issue #13497 — mssql reflection drops fractional-seconds precision. */
export const SCENARIO_13497: Scenario = {
  name: "mssql datetime reflection (#13497)",
  grammar: TYPED_GRAMMAR,
  findings: [
    "Column", "CreateTable", "DATETIME", "DATETIME2", "DATETIMEOFFSET", "MSDialect",
    "MetaData", "NumericCommon", "SMALLDATETIME", "Table", "TIME", "_parse_column_info",
    "columns", "create_engine", "get_columns", "inspect", "precision", "scale", "sys",
  ],
  question: "This SQLAlchemy MSSQL reflection bug drops fractional-seconds precision. What is the root cause?",
};

/** issue #13570 — detached connections are not closed on GC. */
export const SCENARIO_13570: Scenario = {
  name: "detached connection GC leak (#13570)",
  grammar: TYPED_GRAMMAR,
  findings: [
    "Connection", "PoolProxiedConnection", "_ConnectionFairy", "_ConnectionRecord",
    "_checkin", "_close_connection", "_finalize_fairy", "aiosqlite", "create_async_engine",
    "create_engine", "detach", "fairy_ref", "finalize", "get_raw_connection", "pool",
    "sqlite3", "text", "weakref",
  ],
  question: "This SQLAlchemy connection leak leaves detached connections unclosed on GC. What is the root cause?",
};

export interface ScenarioLedger {
  name: string;
  findings: number;
  forestInterpretations: number;
  parse: { requests: number; executions: number; skippedExecutions: number; argTokens: number; resultTokens: number };
  reason: { requests: number; llmCalls: number; skippedLlmCalls: number; promptTokens: number; outputTokens: number };
  totalTokensSpent: number;
  totalTokensSaved: number;
  /** The shared LLM continuation (identical for every caller). */
  diagnosis: string;
}

/**
 * Run `concurrency` concurrent "agents" at a scenario state through both the
 * parse segment and the LLM continuation, and return the resource ledger.
 * `generate(prompt)` is the LLM-backed continuation (a real `completion` in the
 * eval harness, or `ctx.runEphemeralTurn` in a live extension).
 */
export async function runScenario(
  scenario: Scenario,
  concurrency: number,
  generate: (prompt: string) => Promise<string>,
): Promise<ScenarioLedger> {
  const parseBefore = segmentStats();
  const reasonBefore = reasonCounts();
  const promptText = `${scenario.question}\n\nFindings:\n${scenario.findings.join("\n")}`;

  const p = Promise.withResolvers<void>();
  const parseTasks = Array.from({ length: concurrency }, () =>
    p.promise.then(() => parseSegment(scenario.grammar, scenario.findings)),
  );
  const reasonTasks = Array.from({ length: concurrency }, () =>
    p.promise.then(() => coordinatedReason(scenario.grammar, scenario.findings, scenario.question, () => generate(promptText))),
  );
  p.resolve();
  const parses = await Promise.all(parseTasks);
  const reasons = await Promise.all(reasonTasks);

  const parseAfter = segmentStats();
  const reasonAfter = reasonCounts();

  const promptTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(reasons[0]?.output ?? "");
  const perTurnTokens = promptTokens + outputTokens;

  // `followers` is driven by the SHARED coordinator hooks (both steps), so parse
  // skip count is derived from parse-only counters: requests − executions.
  const pRequests = parseAfter.requests - parseBefore.requests;
  const pExecutions = parseAfter.executions - parseBefore.executions;
  const parseDelta = {
    requests: pRequests,
    executions: pExecutions,
    skippedExecutions: pRequests - pExecutions,
    argTokens: parseAfter.argTokens - parseBefore.argTokens,
    resultTokens: parseAfter.resultTokens - parseBefore.resultTokens,
  };
  const reasonDelta = {
    requests: reasonAfter.requests - reasonBefore.requests,
    llmCalls: reasonAfter.llmCalls - reasonBefore.llmCalls,
    skippedLlmCalls: reasonAfter.skippedLlmCalls - reasonBefore.skippedLlmCalls,
    promptTokens,
    outputTokens,
  };

  return {
    name: scenario.name,
    findings: scenario.findings.length,
    forestInterpretations: parses[0]?.parse.valueCount ?? 0,
    parse: parseDelta,
    reason: reasonDelta,
    totalTokensSpent: parseDelta.argTokens + parseDelta.resultTokens + reasonDelta.llmCalls * perTurnTokens,
    totalTokensSaved: reasonDelta.skippedLlmCalls * perTurnTokens,
    diagnosis: reasons[0]?.output ?? "",
  };
}