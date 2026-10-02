// parse-segment.ts — the process-wide single-flight coordinator behind a parse.
//
// The whole point of step 2: ONE Coordinator + ONE Marpa worker at MODULE scope,
// shared across every session/subagent that rebinds this extension (the module
// graph is evaluated once per process). A subagent's `parse_segment` call routes
// `parse_once(grammar, fragments)` through the SAME coordinator, so two
// independent sessions reaching the same `(grammar, prefix)` share one parse.
//
// Separate from `MarpaParseClient` usage: the coordination stays at the module
// boundary here, and the real Marpa parse runs inside the work factory.
import { Redis } from "ioredis";
import {
  Coordinator,
  Ephemeral,
  Hooks,
  RedisBackend,
  RedisCoordinator,
  Ttl,
  type CoordinatorLike,
} from "../promiseflow/index.ts";
import { MarpaParseClient, type ParseOnceResult } from "./marpa-client.ts";
import { segmentKey } from "./segment-key.ts";

/** Aristotle grammar version carried in the segment identity. */
export const SEGMENT_GRAMMAR_VERSION = 1;

/**
 * Stub vague grammar: a stream of "findings" whose GROUPING is underspecified
 * (`doc ::= finding+`, `finding ::= item+`). Structural ambiguity, not lexical:
 * `a b c` parses as one finding, two findings, or three — 4 interpretations.
 * Vague on purpose: any run of loose tokens is accepted, and the ambiguity is the
 * point (two agents disagreeing on how to group the stream produce a forest).
 */
export const DEFAULT_GRAMMAR = [
  ":default ::= action => ::array",
  ":start ::= doc",
  "doc ::= finding+",
  "finding ::= item+",
  "item ~ [A-Za-z0-9_./:-]+",
  ":discard ~ whitespace",
  "whitespace ~ [\\s]+",
].join("\n");

/**
 * v2: typed/tagged findings with STRUCTURED ambiguity instead of partition noise.
 *
 * Each finding is an atomic token; a *temporal* token (DATETIME2, TIME, …) is
 * genuinely ambiguous between a `temporal` finding (a recognized SQL temporal
 * type) and a `marker` finding (a generic symbol mention). The forest size is
 * 2^(temporal-token count) — bounded and semantically meaningful (it counts the
 * "which reading" alternatives of the type/mention distinction), not the 2^(n-1)
 * arbitrary-regrouping blow-up of the v1 `finding+` grammar. This is the exact
 * distinction issue #13497 is about: temporal types vs the generic `NumericCommon`
 * precision/scale path.
 */
export const TYPED_GRAMMAR = [
  ":default ::= action => ::array",
  ":start ::= doc",
  "doc ::= finding+",
  "finding ::= temporal | marker",
  "temporal ::= 'DATETIME2' | 'DATETIMEOFFSET' | 'TIME' | 'SMALLDATETIME' | 'DATETIME'",
  "marker ::= word",
  "word ~ [A-Za-z0-9_]+",
  ":discard ~ whitespace",
  "whitespace ~ [\\s]+",
].join("\n");

export interface SegmentStats {
  /** Completed coordinated requests received. */
  requests: number;
  /** Callers that ran the work factory. */
  owners: number;
  /** Callers that joined an in-flight computation. */
  followers: number;
  /** Callers served a previously completed result (retention reuse, not in-flight). */
  cacheHits: number;
  /** Actual parse_once executions (the number the dedup claim is proven by). */
  executions: number;
  /** Cumulative wall-clock of owner parse executions (ms). */
  computeMs: number;
  /** Estimated tokens the LLM emitted as tool-call arguments (cumulative). */
  argTokens: number;
  /** Estimated tokens the LLM reads back from the result (cumulative). */
  resultTokens: number;
}

export interface SegmentResult {
  /** `segmentKey(grammar, fragments)` — the shared work identity. */
  key: string;
  parse: ParseOnceResult;
  /** Post-call snapshot of the process-wide counters. */
  stats: SegmentStats;
  /** Cumulative estimated LLM tokens spent authoring grammars (see `grammarAuthoringCosts`). */
  grammarAuthorTokens: number;
}

const stats: SegmentStats = { requests: 0, owners: 0, followers: 0, cacheHits: 0, executions: 0, computeMs: 0, argTokens: 0, resultTokens: 0 };

const hooks = new Hooks({
  onOwner: () => {
    stats.owners += 1;
  },
  onFollower: () => {
    stats.followers += 1;
  },
  onCacheHit: () => {
    stats.cacheHits += 1;
  },
});

/** Structural surface both coordinators satisfy (start/close are no-ops where absent). */
interface SegmentCoordinator extends CoordinatorLike {
  start?(): Promise<void>;
  close?(): Promise<void>;
}

let coordinator: SegmentCoordinator | null = null;
let coordinatorInit: Promise<SegmentCoordinator> | null = null;

/** Retention window (seconds) for completed segments; <=0 disables caching. */
function readTtlSeconds(): number {
  const raw = Number(process.env.SEGMENT_TTL_SECONDS ?? "60");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function buildCoordinator(): SegmentCoordinator {
  const ttl = readTtlSeconds();
  const retention = ttl > 0 ? new Ttl(ttl) : new Ephemeral();
  const url = process.env.PF_REDIS_URL;
  if (url) {
    const backend = new RedisBackend(new Redis(url), { namespace: "omp-segment" });
    return new RedisCoordinator(backend, { hooks, retention, staleAfter: 60, heartbeatInterval: 5 });
  }
  return new Coordinator({ hooks, retention, staleAfter: 60, sweepInterval: 1 });
}

async function ensureCoordinator(): Promise<SegmentCoordinator> {
  if (coordinator !== null) return coordinator;
  coordinatorInit ??= (async () => {
    const built = buildCoordinator();
    await built.start?.();
    coordinator = built;
    return built;
  })();
  return coordinatorInit;
}

const client = new MarpaParseClient();

// ---------------------------------------------------------------------------
// Grammar-authoring cost. The model does not inherit a grammar for free: in the
// authoring loop (Aristotle `create`/`extend`, or a `grammar` arg here) it writes
// and rewrites the SLIF source itself, and that text is LLM output tokens — a
// one-time setup cost the dedup savings must be net of. The shipped defaults
// (DEFAULT_GRAMMAR / TYPED_GRAMMAR) cost nothing here; any other grammar source is
// treated as model-authored and charged ONCE per distinct text (a second caller
// reusing the same grammar has already paid for it).
// ---------------------------------------------------------------------------

const authoredGrammars = new Set<string>();
const grammarAuthoring = { events: 0, tokens: 0 };

/** Charge a one-time authoring cost for a distinct, model-authored grammar source. */
function recordGrammarAuthoring(grammar: string): void {
  if (grammar === DEFAULT_GRAMMAR || grammar === TYPED_GRAMMAR) return;
  if (authoredGrammars.has(grammar)) return;
  authoredGrammars.add(grammar);
  grammarAuthoring.events += 1;
  grammarAuthoring.tokens += estimateTokens(grammar);
}

/** Cumulative grammar-authoring cost: distinct authoring events and their estimated tokens. */
export interface GrammarAuthoringCost {
  /** Distinct non-shipped grammar sources the LLM authored (create/extend/arg). */
  events: number;
  /** Estimated LLM output tokens spent authoring those grammars. */
  tokens: number;
}

/** One-time grammar-authoring cost, the setup spend the dedup savings must clear. */
export function grammarAuthoringCosts(): GrammarAuthoringCost {
  return { events: grammarAuthoring.events, tokens: grammarAuthoring.tokens };
}

// ---------------------------------------------------------------------------
// Segment trace (Method-A of the measurement plan). Every key the coordinator is
// asked about is recorded once per request, so a run can report the collision rate
// and occurrence histogram directly instead of guessing. This is independent of
// owners/followers/cacheHits — those say *how* a repeat was served; this says *how
// often* keys repeated at all.
// ---------------------------------------------------------------------------

const segmentOccurrences = new Map<string, number>();

function recordSegmentKey(key: string): void {
  segmentOccurrences.set(key, (segmentOccurrences.get(key) ?? 0) + 1);
}

export interface SegmentTrace {
  /** Total segment requests recorded. */
  total: number;
  /** Distinct segment keys recorded. */
  distinct: number;
  /** `1 − distinct/total`: the fraction of requests that were repeats. */
  collisionRate: number;
  /** Histogram: `occurrences -> number of keys seen that many times`. */
  histogram: Record<number, number>;
}

export function segmentTrace(): SegmentTrace {
  let total = 0;
  const histogram: Record<number, number> = {};
  for (const count of segmentOccurrences.values()) {
    total += count;
    histogram[count] = (histogram[count] ?? 0) + 1;
  }
  const distinct = segmentOccurrences.size;
  return {
    total,
    distinct,
    collisionRate: total === 0 ? 0 : 1 - distinct / total,
    histogram,
  };
}

function snapshot(): SegmentStats {
  return {
    requests: stats.requests,
    owners: stats.owners,
    followers: stats.followers,
    cacheHits: stats.cacheHits,
    executions: stats.executions,
    computeMs: stats.computeMs,
    argTokens: stats.argTokens,
    resultTokens: stats.resultTokens,
  };
}

/** Read-only snapshot of the process-wide coordinator counters. */
export function segmentStats(): SegmentStats {
  return snapshot();
}

/** Saved work: parses avoided by in-flight followers or retained-value reuse. */
export interface DedupSavings {
  requests: number;
  executions: number;
  followers: number;
  /** Callers served a retained result (near-in-time reuse, not in-flight). */
  cacheHits: number;
  /** Parse executions avoided (in-flight followers + retention cache hits). */
  skippedExecutions: number;
  /** Actual parse compute (owners only), ms. */
  computeMs: number;
  /** Mean per-execution parse time, ms. */
  meanExecutionMs: number;
  /** Estimated parse time saved = skippedExecutions × meanExecutionMs. */
  estimatedSavedMs: number;
  /** Estimated tokens the LLM emitted as tool-call arguments. */
  argTokens: number;
  /** Estimated tokens the LLM read back from results. */
  resultTokens: number;
  /** Total LLM tokens spent across all requests (args out + result in). */
  totalTokens: number;
  /**
   * Tokens saved by dedup. ZERO today: the deduplicated unit (the Marpa parse)
   * is not an LLM operation, so every request still pays args + result tokens.
   * Becomes nonzero once the shared segment is an LLM-backed step.
   */
  skippedTokens: number;
  /**
   * One-time setup cost: estimated LLM tokens the model spent AUTHORING a non-
   * shipped grammar source. Dedup savings must clear this before they are net.
   */
  grammarAuthorTokens: number;
}

/**
 * Derived savings view: every follower is a *parse* that did not re-run (compute
 * savings). Token savings is tracked separately and is currently zero, because
 * dedup shares the parse, not the LLM call(s).
 */
export function dedupSavings(): DedupSavings {
  const s = snapshot();
  const mean = s.executions > 0 ? s.computeMs / s.executions : 0;
  const avoided = s.followers + s.cacheHits;
  return {
    requests: s.requests,
    executions: s.executions,
    followers: s.followers,
    cacheHits: s.cacheHits,
    skippedExecutions: avoided,
    computeMs: s.computeMs,
    meanExecutionMs: mean,
    estimatedSavedMs: avoided * mean,
    argTokens: s.argTokens,
    resultTokens: s.resultTokens,
    totalTokens: s.argTokens + s.resultTokens,
    skippedTokens: 0,
    grammarAuthorTokens: grammarAuthoring.tokens,
  };
}

/** chars/4 heuristic for LLM token cost — a labeled estimate, not exact. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * The exact text a caller's model reads back. Single source of truth: the tool
 * result and the token accounting both derive from this.
 */
export function renderSegment(key: string, parse: ParseOnceResult, stats: SegmentStats): string {
  const lines: string[] = [`segment ${key}`];
  lines.push(`parse: ${parse.status} — ${parse.valueCount} interpretation${parse.valueCount === 1 ? "" : "s"}`);
  for (const v of parse.values.slice(0, 5)) lines.push(`  ${v}`);
  if (parse.valueCount > parse.values.length) lines.push(`  … ${parse.valueCount - parse.values.length} more`);
  lines.push(
    `coordinator: requests=${stats.requests} executions=${stats.executions} owners=${stats.owners} followers=${stats.followers}`,
  );
  return lines.join("\n");
}

export function parseSegment(grammar: string, fragments: string[]): Promise<SegmentResult> {
  const key = segmentKey({ version: SEGMENT_GRAMMAR_VERSION, grammar, fragments });
  const argTokens = estimateTokens(JSON.stringify(fragments));
  return ensureCoordinator()
    .then((coord) =>
      coord.getOrRun(key, async () => {
        stats.executions += 1;
        const started = performance.now();
        try {
          return await client.parseOnce(grammar, fragments);
        } finally {
          stats.computeMs += performance.now() - started;
        }
      }),
    )
    .then((parse) => {
      stats.requests += 1;
      stats.argTokens += argTokens;
      stats.resultTokens += estimateTokens(renderSegment(key, parse, stats));
      recordGrammarAuthoring(grammar);
      recordSegmentKey(key);
      return { key, parse, stats: snapshot(), grammarAuthorTokens: grammarAuthoring.tokens };
    });
}

export interface StepSegmentResult {
  /** The single step fragment this segment is keyed on. */
  step: string;
  /** The per-step segment result (`segmentKey(grammar, [step])`). */
  result: SegmentResult;
}

/**
 * Per-step variant: key each step on its own `(grammar, [step])` segment instead of
 * the whole flow, so a shared step reached from different flows collides at the same
 * coordinator (disconnected sharing) and, with retention, reuses a cached result. The
 * ordered-prefix identity cannot see this — two flows rarely start with the same step —
 * so this is the variant that captures the shared mid-flow work the chunking demo found.
 */
export function parseSegmentSteps(grammar: string, steps: string[]): Promise<StepSegmentResult[]> {
  return Promise.all(steps.map((step) => parseSegment(grammar, [step]).then((result) => ({ step, result }))));
}

/** Terminate the shared Marpa worker (teardown; tests). */
export function shutdownSegment(): void {
  client.terminate();
  void coordinator?.close?.();
}

/** Which backend the segment coordinator uses, and its cache window. */
export function segmentCoordinatorConfig(): { backend: "memory" | "redis"; ttlSeconds: number } {
  return {
    backend: process.env.PF_REDIS_URL ? "redis" : "memory",
    ttlSeconds: readTtlSeconds(),
  };
}

/** Close the coordinator and reset counters, trace, and authoring (teardown; tests). */
export async function resetSegmentCoordinator(): Promise<void> {
  const current = coordinator;
  coordinator = null;
  coordinatorInit = null;
  await current?.close?.();
  stats.requests = 0;
  stats.owners = 0;
  stats.followers = 0;
  stats.cacheHits = 0;
  stats.executions = 0;
  stats.computeMs = 0;
  stats.argTokens = 0;
  stats.resultTokens = 0;
  authoredGrammars.clear();
  grammarAuthoring.events = 0;
  grammarAuthoring.tokens = 0;
  segmentOccurrences.clear();
  reasonRequests.count = 0;
  llmExecutions.count = 0;
  llmTokens.input = 0;
  llmTokens.output = 0;
}

// ---------------------------------------------------------------------------
// LLM-backed segment step: coordinate an LLM continuation keyed by the parse
// state, so repeat/parallel arrivals at the SAME state SKIP the LLM call.
//
// This is where token budget is actually saved (one fewer LLM turn per skipped
// caller), unlike parse dedup which only saves Marpa compute. Uses a DISTINCT
// scheme so reason segments never collide with parse segments on the same key.
// ---------------------------------------------------------------------------

/** Namespace for LLM-step segments (distinct from parse segments). */
export const REASON_SCHEME = "aristotle-reason/v1";

const reasonRequests = { count: 0 };
const llmExecutions = { count: 0 };

export interface ReasonResult {
  key: string;
  output: string;
  /** Total LLM continuations run so far (process-wide). */
  llmCalls: number;
  /** Reason-requests served WITHOUT running the LLM (followers). */
  skippedLlmCalls: number;
  /** Cumulative REAL provider input/output tokens of the LLM continuations run. */
  llmInputTokens: number;
  llmOutputTokens: number;
  /** Cumulative estimated LLM tokens spent authoring grammars (setup cost). */
  grammarAuthorTokens: number;
}

/** A coordinate-able LLM continuation step. Omit `usage` for a string-only provider. */
export type LlmStep = string | { text: string; usage?: { input: number; output: number } };

const llmTokens = { input: 0, output: 0 };

/**
 * Coordinate an LLM-backed continuation behind the SAME coordinator, keyed by the
 * parsed state `(grammar, fragments)`. Two callers at the same state run
 * `generate` once; the follower receives the output and does NOT call the LLM.
 *
 * `generate` may return a plain string or `{ text, usage }`; `usage` is the real
 * provider `message.usage` (input/output tokens) so the SKIPPED turn's true cost
 * is recorded, not estimated (`ctx.runEphemeralTurn`'s `assistantMessage.usage` is
 * the intended source).
 */
export function coordinatedReason(
  grammar: string,
  fragments: string[],
  prompt: string,
  generate: (fragments: string[]) => Promise<LlmStep> | LlmStep,
): Promise<ReasonResult> {
  const key = segmentKey({ scheme: REASON_SCHEME, version: SEGMENT_GRAMMAR_VERSION, grammar, fragments, prompt });
  return ensureCoordinator()
    .then((coord) =>
      coord.getOrRun(key, async () => {
        llmExecutions.count += 1;
        const out = await generate(fragments);
        const text = typeof out === "string" ? out : out.text;
        const usage = typeof out === "string" ? undefined : out.usage;
        if (usage) {
          llmTokens.input += usage.input;
          llmTokens.output += usage.output;
        }
        return text;
      }),
    )
    .then((output) => {
      reasonRequests.count += 1;
      recordGrammarAuthoring(grammar);
      recordSegmentKey(key);
      return {
        key,
        output,
        llmCalls: llmExecutions.count,
        skippedLlmCalls: reasonRequests.count - llmExecutions.count,
        llmInputTokens: llmTokens.input,
        llmOutputTokens: llmTokens.output,
        grammarAuthorTokens: grammarAuthoring.tokens,
      };
    });
}

/** LLM-step counters: requests, actual LLM calls, skipped calls, and REAL token usage. */
export function reasonCounts(): {
  requests: number;
  llmCalls: number;
  skippedLlmCalls: number;
  inputTokens: number;
  outputTokens: number;
  grammarAuthorTokens: number;
} {
  return {
    requests: reasonRequests.count,
    llmCalls: llmExecutions.count,
    skippedLlmCalls: reasonRequests.count - llmExecutions.count,
    inputTokens: llmTokens.input,
    outputTokens: llmTokens.output,
    grammarAuthorTokens: grammarAuthoring.tokens,
  };
}