# Verification bundle — Aristotle × PromiseFlow (M15 → step 3 → LLM-step)

This file is a self-contained evidence pack for independent review. It contains the
raw subagent transcripts (which are *not* reproduced in a chat-log paste), the
measured numbers, and the load-bearing source that produces them, so the claims can
be checked against the code rather than taken on faith.

Repos: `F:\promiseflow-omp` (PromiseFlow coordination + experiments) and
`F:\aristotle` (Marpa worker + Aristotle extension).

---

## 1. Notation and honesty up front

- **"executions"** = how many times the *work factory* (the actual `parse_once` or LLM
  `generate`) ran. This is the number every dedup claim is proven by; it is an
  in-factory increment, not an inference.
- **"requests"** = how many callers issued the coordinated call. `skipped = requests − executions`.
- **"tokens"** are a **`chars/4` heuristic estimate** (clearly labeled in
  `estimateTokens`), not provider metering. LLM output length varies run-to-run, so
  token counts are approximate; the *structure* (which fraction of calls was skipped)
  is exact.
- The scenario runs used the OMP eval kernel's **`completion()`** (a real LLM oneshot)
  as the `generate` work factory. In a live OMP session the same slot is
  `ctx.runEphemeralTurn({ promptText })`. Both are real LLM calls; neither is simulated.
- **Ground-truth token usage exists in the session transcripts and is much larger than
  the bundle's estimates — see §9.** The subagents' real OpenRouter `usage` shows a
  single agent turn costs **~20k–160k tokens** (dominated by the re-sent system
  prompt), not the ~620 the early work estimated. The `~1130`/`~1012` figures in §6
  measure the small `completion()` unit; the full-turn number is 1–2 orders larger.
- **Known limitation found & fixed during the run:** `SegmentStats.followers` is
  incremented by the *shared* coordinator hooks used by both the parse step and the
  LLM step, so a naive "followers delta" conflagrates the two. The harness derives
  parse-skip from parse-only counters (`requests − executions`). This is noted here so a
  reviewer doesn't trip on it.

Reproduce:
```sh
cd F:/promiseflow-omp
bun test                       # 82 pass / 0 fail (13 files)
bun run typecheck              # tsc --noEmit, exit 0

cd F:/aristotle
node --experimental-strip-types --test "tests/*.test.ts"   # 39 pass / 1 skip / 0 fail
npx tsc --noEmit              # exit 0
```
(The scenario LLM run itself is reproduced by calling `runScenario(scenario, N, generate)`
from `experiments/sqlalchemy-scenarios.ts` with a real `generate`; see §6.)

---

## 2. Core claim 1 — single-flight: N concurrent callers → 1 execution

The coordinator's `run()` decides owner vs follower synchronously and shares one future
(`F:\promiseflow-omp\extensions\pf-coordinator\promiseflow\coordinator.ts`), verbatim:

```ts
getOrRun<R = T>(key, workFactory, options = {}) {
    return this.run(key, workFactory, {
        retry: options.retry ?? new RetryPolicy(),
        timeout: options.timeout,
        heartbeatInterval: options.heartbeatInterval ?? 1,
        useCache: true,
        retention: options.retention ?? this.retention,   // Ephemeral: retain=false
    });
}

private async run<R>(key, workFactory, params) {
    const { retry, timeout, heartbeatInterval, useCache, retention } = params;
    let lastError;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        await retry.sleepBeforeAttempt(attempt);
        if (attempt > 1) await this.hooks.emit("onRetry", key, attempt);
        if (useCache) {
            const lookup = this.retentionLookup(key, retention);   // Ephemeral -> "miss"
            if (lookup.status === "hit") { await this.hooks.emit("onCacheHit", key); return lookup.value; }
            if (lookup.status === "stale") { /* refresh path */ }
        }
        const token = {};
        const { entry, isOwner } = this.claimOrJoin(key, token);   // SAME entry, ONE owner
        const timeoutError = new WorkTimeoutError(...);
        if (!isOwner) {
            await this.hooks.emit("onFollower", key);
            try { return await awaitWithTimeout(entry.future.promise, timeout, timeoutError); }
            catch (error) { if (error === timeoutError) throw error; lastError = error; continue; }
        }
        await this.hooks.emit("onOwner", key);
        const heartbeat = this.startHeartbeat(key, token, heartbeatInterval);
        try {
            const result = await awaitWithTimeout(Promise.resolve().then(workFactory), timeout, timeoutError);
            this.resolveIfOwner(key, token, result, retention);
            await this.hooks.emit("onSuccess", key, /* elapsed */ 0);
            return result;
        } catch (error) {
            this.rejectIfOwner(key, token, error);      // shared future rejected -> followers see it
            await this.hooks.emit("onError", key, error);
            lastError = error;
            if (error instanceof WorkTimeoutError && attempt === retry.maxAttempts) throw error;
        } finally { heartbeat.stop(); }
    }
    throw new RetryExhaustedError(...);
}

private claimOrJoin(key, ownerToken) {
    const current = this.entries.get(key);
    if (current === undefined || current.future.settled) {
        const entry = new WorkEntry(createDeferred(), ownerToken);
        this.entries.set(key, entry);
        return { entry, isOwner: true };     // first (unsettled) claimer is owner
    }
    return { entry: current, isOwner: false };   // everyone else is follower
}

private resolveIfOwner(key, ownerToken, result, retention) {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.ownerToken !== ownerToken) return;
    if (!entry.future.settled) entry.future.resolve(result);   // ONE value, all awaiters get it
    this.entries.delete(key);
    if (retention.retain) this.results.set(key, { value: result, created: performance.now() });
}

private rejectIfOwner(key, ownerToken, error) {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.ownerToken !== ownerToken) return;
    if (!entry.future.settled) entry.future.reject(error);
    this.entries.delete(key);   // settled entry removed -> no poisoned segment
}
```

With `Ephemeral` (default), `retentionLookup` always returns `"miss"` (`if (!retention.retain) return { status: "miss" }`), so dedup is **in-flight only** — followers join the owner's shared future; a *sequential* later caller recomputes.

The deterministic test that pins the claim
(`experiments/parse-segment.test.ts`, verbatim assertions):

```ts
test("two concurrent identical segments → one execution (shared coordinator)", async () => {
  const before = segmentStats();
  const fragments = ["session commit rollback"];
  const gate = createDeferred<void>();
  const callA = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  const callB = gate.promise.then(() => parseSegment(DEFAULT_GRAMMAR, fragments));
  gate.resolve();                              // both fire in one microtask flush
  const [ra, rb] = await Promise.all([callA, callB]);
  const after = segmentStats();
  expect(after.executions - before.executions).toBe(1);  // the dedup claim
  expect(delta.owners).toBe(1); expect(delta.followers).toBe(1);
  expect(ra.parse).toEqual(rb.parse);          // identical result to both
});
```

The owner/follower split is deterministic because `parse_once` is async I/O: both
callers enter `run()` in the same tick, the first hits `claimOrJoin` (owner), the second
hits `claimOrJoin` on the still-unsettled entry (follower) before the parse I/O resolves.
This same test run on 2026-09-25 reported **3 pass / 0 fail** for the file and
**82 pass / 0 fail** for the whole `bun test` suite.

---

## 3. Core claim 2 — the segment identity is computed before the parse

`experiments/segment-key.ts` (complete):

```ts
import { stableHash } from "../promiseflow/keying.ts";
export const SEGMENT_SCHEME = "aristotle-turn/v1";

export interface SegmentKeyInput {
  version: number;
  grammar: string;
  fragments: string[];
  scheme?: string;
}

export function segmentKey(input) {
  const scheme = input.scheme ?? SEGMENT_SCHEME;
  const payload = { scheme, version: input.version, grammar: input.grammar, fragments: input.fragments };
  return `${scheme}#${stableHash(payload)}`;   // sha256 of canonical JSON
}
```

`stableHash` (`pf-coordinator/promiseflow/keying.ts`) is `sha256(canonicalJson(value))`,
where `canonicalJson` recursively sorts object keys and preserves array order — so the
**ordered** fragment list is part of the identity. The key needs only `(grammar,
fragments)` — never the parse result — so two sessions converge on it *before* parsing.

The LLM-step uses a distinct namespace so it never collides with a parse segment on the
same `(grammar, fragments)`:
`REASON_SCHEME = "aristotle-reason/v1"` (`experiments/parse-segment.ts`).

---

## 4. Core claim 3 — the forest counts are real Marpa enumerations

The worker's ambiguity oracle is a true parse-forest enumeration
(`F:\aristotle\worker\marpa-worker.pl`, `enumerate_values`, verbatim):

```perl
sub enumerate_values {
    my ($grammar, $input) = @_;
    my $recce = Marpa::R2::Scanless::R->new({ grammar => $grammar, semantics_package => 'ReasonTrace' });
    my ($status, $error, $value_count, $progress);
    my @values = (); $value_count = 0;
    my $ok = eval {
        $recce->read(\$input);
        while (defined(my $v = $recce->value())) {   # loop over the ENTIRE forest
            $value_count++;
            push @values, _render($v) if @values < 5;   # render first 5 only
        }
        1;
    };
    if (!$ok || $value_count == 0) { $status = "INVALID"; ... }
    elsif ($value_count > 1) { $status = "AMBIGUOUS"; }
    else { $status = "VALID"; }
    ...
}
```

`value_count` is **not** a heuristic: it is the number of distinct parse trees Marpa's
recognizer yields. The stateless op added for M15 feeds this
(`op_parse_once`, same worker, verbatim):

```perl
sub op_parse_once {
    my ($id, $req) = @_;
    my $grammar = $req->{grammar};
    if (!defined $grammar || !length "$grammar") { send_error($id, "BAD_ARGS", ...); return; }
    my $fragments = $req->{fragments};
    if (ref($fragments) ne 'ARRAY') { send_error($id, "BAD_ARGS", ...); return; }
    my $g; my $ok = eval { $g = compile_grammar($grammar); 1 };
    if (!$ok) { send_error($id, "GRAMMAR_ERROR", clean_error($@)); return; }
    my $input = join " ", map { defined $_ ? "$_" : "" } @$fragments;
    my ($status, $value_count, $values, $error, $progress) = enumerate_values($g, $input);
    my $resp = { id => $id, ok => $TRUE, status => $status, value_count => $value_count,
                 values => $values, fragment_count => scalar @$fragments };
    $resp->{error} = $error if defined $error;
    $resp->{progress} = $progress if defined $progress;
    send_response($resp);
}
```

**Measured forest counts** (real worker output, collected during development, never
asserted without a run first):

| grammar | input | status | value_count |
|---|---|---|---|
| naive dangling-else `stmt ::= 'if' 'then' stmt 'else' stmt \| 'if' 'then' stmt \| 's'` | `if then if then if then s else s` (k=3,l=1) | AMBIGUOUS | 3 |
| same | `… s else s else s` (k=3,l=2) | AMBIGUOUS | 3 |
| same | `… s else s else s else s` (k=3,l=3) | VALID | 1 |
| expr `e ::= e '+' e \| e '*' e \| n` | `1 + 2 * 3` | AMBIGUOUS | 2 |
| same | `1 + 2 * 3 + 4 * 5` | AMBIGUOUS | 14 |
| precedence `e ::= e '+' t \| t …` | `1 + 2 * 3` | VALID | 1 |
| `doc ::= finding+ ; finding ::= item+` (v1) | `a b c` | AMBIGUOUS | 4 (= 2^(3-1)) |
| same, 19 findings | … | AMBIGUOUS | 262 144 (= 2^18) |
| `temporal \| marker` (v2), 1 temporal + 2 generic | `DATETIME2 Column NumericCommon` | AMBIGUOUS | 2 |
| v2, 3 temporal + 3 generic | `DATETIME2 DATETIMEOFFSET TIME Column MetaData Table` | AMBIGUOUS | 8 (= 2^3) |
| v2, no temporal | `Column NumericCommon create_engine inspect` | VALID | 1 |

(The dangling-else counts follow Pascal's triangle `C(k,l)`; the v1 `finding+` counts are
`2^(n-1)` — the exponential "partition noise" that motivated the v2 grammar.)

---

## 5. Core claim 4 — two *independent subagents* converged (tight schema) / diverged (loose schema)

These are the four real subagent runs (spawned via OMP's `task` tool with the same prompt;
their transcripts are what a chat log omits). All four were independent `task` subagents.

**Loose schema (step 3, first run) — DIVERGED.** Issue #13497 extraction with prose
rules ("sort and dedupe the SQLAlchemy symbols"):

`ExtractA` (15 items):
```
["Column","CreateTable","DATETIME","DATETIME2","DATETIMEOFFSET","MetaData",
 "MSDialect._parse_column_info","NumericCommon","SMALLDATETIME","Table","TIME",
 "create_engine","inspect","sys.columns.precision","sys.columns.scale"]
```

`ExtractB` (16 items):
```
["Column","CreateTable","DATETIME","DATETIME2","DATETIMEOFFSET","MetaData",
 "NumericCommon","SMALLDATETIME","TIME","Table","_parse_column_info",
 "create_engine","get_columns","inspect","sys.columns.precision","sys.columns.scale"]
```

Measured symmetric difference: `only-in-A = ["MSDialect._parse_column_info"]`,
`only-in-B = ["_parse_column_info","get_columns"]` — i.e. diverged on (a) qualified vs
unqualified method naming and (b) whether `get_columns` counts. `A == B` is **false**,
so their segment keys differed and dedup could not fire.

**Tight schema (step 3, rerun) — CONVERGED.** Same issue, but the rules were made
deterministic (atomize every dotted identifier at `.`; explicit include/exclude lists).

`ConvA` (19 items):
```
["Column","CreateTable","DATETIME","DATETIME2","DATETIMEOFFSET","MSDialect",
 "MetaData","NumericCommon","SMALLDATETIME","Table","TIME","_parse_column_info",
 "columns","create_engine","get_columns","inspect","precision","scale","sys"]
```

`ConvB` (19 items): **byte-identical** to `ConvA`.

`JSON.stringify(ConvA) === JSON.stringify(ConvB)` → `true`; `segmentKey` equal;
feeding the converged list through `parseSegment(TYPED_GRAMMAR, …)` reported
`AMBIGUOUS, value_count = 32` (2^5, the five temporal tokens), and two concurrent
callers reported `requests=2, executions=1, owners=1, followers=1`.

---

## 6. Core claim 5 — real SQLAlchemy scenario results (token & compute ledger)

Scenarios are defined in `experiments/sqlalchemy-scenarios.ts` (findings are the real
issue symbols, grammar is the shared `TYPED_GRAMMAR`):

```ts
export const SCENARIO_13497 = {
  name: "mssql datetime reflection (#13497)",
  grammar: TYPED_GRAMMAR,
  findings: ["Column","CreateTable","DATETIME","DATETIME2","DATETIMEOFFSET","MSDialect",
    "MetaData","NumericCommon","SMALLDATETIME","Table","TIME","_parse_column_info",
    "columns","create_engine","get_columns","inspect","precision","scale","sys"],
  question: "This SQLAlchemy MSSQL reflection bug drops fractional-seconds precision. What is the root cause?",
};

export const SCENARIO_13570 = {
  name: "detached connection GC leak (#13570)",
  grammar: TYPED_GRAMMAR,
  findings: ["Connection","PoolProxiedConnection","_ConnectionFairy","_ConnectionRecord",
    "_checkin","_close_connection","_finalize_fairy","aiosqlite","create_async_engine",
    "create_engine","detach","fairy_ref","finalize","get_raw_connection","pool",
    "sqlite3","text","weakref"],
  question: "This SQLAlchemy connection leak leaves detached connections unclosed on GC. What is the root cause?",
};
```

`runScenario` drives **concurrency=3** callers through both `parseSegment` (Marpa) and
`coordinatedReason` (LLM continuation), and returns a ledger. The `generate` work factory
was the eval kernel's real `completion()` (a oneshot LLM). Measured (final clean run,
2026-09-25):

| field | #13497 | #13570 |
|---|---|---|
| findings | 19 | 18 |
| forest interpretations | 32 (5 temporal) | 1 (no temporal) |
| parse: requests / executions / skipped | 3 / 1 / 2 | 3 / 1 / 2 |
| parse argTokens / resultTokens | 174 / 1170 | 198 / 363 |
| reason: requests / llmCalls / skippedLlmCalls | 3 / 1 / 2 | 3 / 1 / 2 |
| reason promptTokens / outputTokens | 75 / 490 | 84 / 422 |
| grammar authoring tokens (shipped grammar → 0) | 0 | 0 |
| **tokens spent (estimate)** | ~1909 | ~1067 |
| **tokens saved (estimate)** | ~1130 | ~1012 |
| **net tokens saved (saved − authoring)** | ~1130 | ~1012 |

Diagnoses (truncated in capture, both correct):
- #13497 → *"the MSSQL dialect doesn't properly handle fractional-seconds precision (scale) when reflecting `TIME`/`DATETIME2`…"*
- #13570 → *"`detach()` removes the `_ConnectionFairy`'s reference to its `_ConnectionRecord` without disposing…"*

The `reason` step's skip is the token saving: `skippedLlmCalls × (promptTokens +
outputTokens)`. `parse` dedup contributes compute savings but zero LLM tokens (every
caller still emits args + reads the result regardless of owner/follower).

**Grammar-authoring cost (added after external review).** Both surfaces now also track how
much the LLM spent *writing* the grammar: the Aristotle `reason` tool charges `create`/`extend`
carrying a `grammar` string into `grammar_author_tokens` (chars/4), and the segment path charges
a non-shipped `grammar` argument into `grammarAuthorTokens` once per distinct source. The
scenarios above use the shipped `TYPED_GRAMMAR`, so authoring is 0 and net = saved; a run where
the model authors its own grammar subtracts that one-time spend from `skippedLlmCalls × turn`.
`runScenario` reports both `grammarAuthorTokens` and `netTokensSaved`.

---

## 7. How the wrappers produce those counters

`experiments/parse-segment.ts` — the two coordinated entry points and the counters
(the increments are in-factory, so `executions`/`llmCalls` are authoritative):

```ts
const stats = { requests:0, owners:0, followers:0, executions:0, computeMs:0, argTokens:0, resultTokens:0 };
const coordinator = new Coordinator({
  retention: new Ephemeral(),
  hooks: new Hooks({
    onOwner: () => { stats.owners += 1; },
    onFollower: () => { stats.followers += 1; },
  }),
});
const client = new MarpaParseClient();   // module scope: shared across the process/sessions

export function parseSegment(grammar, fragments) {
  const key = segmentKey({ version: SEGMENT_GRAMMAR_VERSION, grammar, fragments });
  const argTokens = estimateTokens(JSON.stringify(fragments));
  return coordinator.getOrRun(key, async () => {
      stats.executions += 1;
      const started = performance.now();
      try { return await client.parseOnce(grammar, fragments); }
      finally { stats.computeMs += performance.now() - started; }
    })
    .then((parse) => {
      stats.requests += 1;
      stats.argTokens += argTokens;
      stats.resultTokens += estimateTokens(renderSegment(key, parse, stats));
      return { key, parse, stats: snapshot() };
    });
}

export function coordinatedReason(grammar, fragments, generate) {
  const key = segmentKey({ scheme: REASON_SCHEME, version: SEGMENT_GRAMMAR_VERSION, grammar, fragments });
  return coordinator.getOrRun(key, async () => {
      llmExecutions.count += 1;          // == number of actual LLM calls
      return generate(fragments);
    })
    .then((output) => {
      reasonRequests.count += 1;
      return { key, output, llmCalls: llmExecutions.count,
               skippedLlmCalls: reasonRequests.count - llmExecutions.count };
    });
}
```

`estimateTokens(text) = max(1, round(text.length / 4))`; `renderSegment` is the single
source of truth for the result text the model reads (so the `resultTokens` estimate is
taken over exactly what is sent back).

---

## 8. What a reviewer should NOT infer

- **Not a cache.** `Ephemeral` retention means only *concurrent in-flight* callers share;
  a later sequential caller recomputes (measured: 2 sequential same-state → 2 executions).
- **Parse dedup ≠ token dedup.** The Marpa parse is not an LLM operation. Parse dedup
  saves compute (`skippedExecutions`, `estimatedSavedMs`) and **zero tokens**; only the
  LLM-step (`coordinatedReason`) saves tokens (`skippedLlmCalls × per-turn tokens`).
- **Token numbers are estimates** (`chars/4`), and per-run LLM verbosity shifts
  `outputTokens` (± a few hundred tokens); the skipped-call *count* is exact.
- **A live OMP loop-level "skip the next model call" is not yet wired.** The LLM-step is
  demonstrated through the shared in-process coordinator with a real oneshot LLM (eval
  `completion`) — or, in the loadable extension, `ctx.runEphemeralTurn`. Truly skipping
  the in-loop provider call (not a coordinated side turn) is the `after_agent_step`
  core-hook item, out of scope.

---

## 9. Ground truth from the session transcripts (added after external review)

The session artifact directory
`~/.omp/agent/sessions/--F--promiseflow-omp--/2026-09-25T00-59-01-773Z_01a0d612-a70d-7797-a8af-0bd9ead7077e/`
contains each subagent's full `.jsonl` transcript and its structured `.json` output.

**Subagent outputs — verbatim match.** `ConvA.json === ConvB.json` (the 19-token list in
§5, byte-identical); `ExtractA.json`/`ExtractB.json` reproduce exactly the
qualified-vs-unqualified (`MSDialect._parse_column_info` vs `_parse_column_info`) and
`get_columns` divergence quoted in §5.

**Real token usage — provider-reported, not estimated.** Each transcript records
`message.usage` (OpenRouter). Totals per subagent (full turns, input+output):

| subagent | turns | total tokens |
|---|---|---|
| ConvA | 1 | 27,511 (25,837 in / 1,674 out) |
| ConvB | 1 | 20,072 (17,645 in / 2,427 out) |
| ExtractA | 2 | ~51,587 |
| ExtractB | 6 (retried on `openrouter/free`) | ~159,595 |

Two consequences:

1. **The earlier "`~620`-token issue-read" estimate was wrong by ~100×.** A subagent
   turn is dominated by the ~25k-token system prompt + context re-sent every turn, not
   the (tiny) issue text. The real unit "one more agent turn" is **20k–160k tokens**.
2. **The `~1130`/`~1012` "tokens saved" figures in §6 measure the small unit.** They
   derive from a ~500-token `completion()`; the full-turn continuation the architecture
   actually wants to skip is 1–2 orders of magnitude larger. The mechanism (1 execution,
   2 skipped) is unchanged and proven; the headline magnitude was *understated*, and the
   `chars/4` heuristic happened to undershoot.

**What the log does NOT contain:** provider usage for the eval `completion()` calls (the
`75/490/84/422` inputs to §6's arithmetic). Those remain single-sample `chars/4`
estimates. Ground-truth for the *continuation* cost requires rerunning
`coordinatedReason` with a `generate` whose usage is recorded (the extension's
`ctx.runEphemeralTurn` assistant message records `message.usage`).

**Diagnosis grounding (was self-certified; now checkable).** The scenario diagnoses
match the source issues:
- #13497 body: *"`MSDialect._parse_column_info` only maps `precision`/`scale` onto
  subclasses of `NumericCommon`, so the datetime/time types come back without a
  precision…"* — what the LLM stated; maintainer CaselIT adds "the reflection logic was
  rewritten for 2.1"; reporter's fix is "a small addition to `_parse_column_info`".
- #13570 body (author zzzeek): *"`_ConnectionFairy.detach()` clears
  `_ConnectionRecord.fairy_ref`, so when the fairy is later collected the cleanup is
  skipped… a fix would need the detached fairy to keep a finalizer that closes over
  `connection_record=None`."* — matches the LLM's "detach removes the fairy's reference
  to its record without disposing".

---

## 10. Live continuation dedup — real token ledger (18.3.2)

The §9 item marked "does NOT contain" is now closed: `coordinatedReason` was rerun
through the loaded extension with `ctx.runEphemeralTurn` as the `generate` provider,
which records the real `assistantMessage.usage`. Session artifact directory (this run):

`~/.omp/agent/sessions/--F--promiseflow-omp--/2026-09-26T01-09-15-792Z_01a0db42-6190-74c7-8e33-f3326dd05a69/`

**Version gate (why this run exists a second time).** The prior attempt ran on
`omp/18.2.11`; `reason_segment` short-circuited with *"no side-turn/LLM primitive in this
host"* because `ctx.runEphemeralTurn` did not exist yet — it was added in 18.3.0
(`ExtensionContextActions` gained the optional `runEphemeralTurn` slot, and
`runtime-init.ts` then wires `args => session.runEphemeralTurn(args)`). `parse_segment`
worked on 18.2.11 (pure Marpa, no side turn); only the LLM-step was gated. On
`omp/18.3.2` both run, and the coordinated LLM continuation dedups.

**Counter ledger — authoritative `details` (cumulative module scope).** The
process-wide counters accumulate across every LLM-executing call, so the subagents see
running totals and the per-turn cost is the *delta*:

| call | `llmCalls` | `skippedLlmCalls` | `llmInputTokens` | `llmOutputTokens` | Δ in / Δ out |
|---|---|---|---|---|---|
| baseline #1 (main, sequential) | 1 | 0 | 7,381 | 1,496 | 7,381 / 1,496 |
| baseline #2 (main, sequential) | 2 | 0 | 12,489 | 2,697 | 5,108 / 1,201 |
| `DedupRedoB` (owner) | 3 | 0 | 13,010 | 3,491 | **521 / 794** |
| `DedupRedoA` (follower) | 3 | **1** | 13,010 | 3,491 | 0 / 0 |

Two concurrent subagents at the same `(grammar, fragments)` state produced **one** new
execution (`llmCalls` 2→3, not 2→4), one `skippedLlmCalls=1`, and one token delta
(521 in / 794 out). Single-flight collapse is proven live end-to-end, not just in the
eval harness. `DedupRedoA` is the follower (its request resolved with `skipped=1`, zero
token delta); `DedupRedoB` is the owner (it paid the one real turn).

**Subagent ground truth (full turns, `message.usage`).** Each `DedupRedo*` transcript
records three provider turns — a `typesafe` routing call, the decision turn that emits
the `reason_segment` tool call, and the final `yield` turn:

| subagent | typesafe | decision turn | final turn | side-turn `details` |
|---|---|---|---|---|
| DedupRedoA (follower) | 652 in / 46 out | 16,777 in / 229 out | 627 in / 258 out (+16,640 cacheRead) | skipped — 0 tokens |
| DedupRedoB (owner) | 652 in / 46 out | 16,777 in / 225 out | 623 in / 181 out (+16,640 cacheRead) | 521 in / 794 out |

**`llmInputTokens` counts only *uncached* input.** The provider usage splits `input`
(uncached), `output`, and `cacheRead`, with `totalTokens = input + output + cacheRead`
(verified on the transcripts: 627 + 258 + 16,640 = 17,525). The extension feeds
`assistantMessage.usage.input` (uncached) into `llmInputTokens`, so the counter is the
*incremental* prompt delta, not the full side-turn prompt. The subagent side turn's
recorded 521 sits on top of a ~16.6k cached system-context prefix, warmed by the
subagent's own 16,777-token decision turn (the following `yield` turn then reports
`cacheRead: 16,640`). The main baseline behaves identically: turn 1 is cold (7,381
uncached), turn 2 drops to 5,108 uncached once the repeated prefix is cached.

**Why the side-turn prompt is ~16.7k for a subagent but ~7.4k for the main session.**
`runEphemeralTurn` snapshots the *invoking* context: a subagent's snapshot equals its
full turn (its own context is the ~16.7k system prompt + task spec, no prior history),
while the main session's side turn is only the ~7.4k system prompt + question + 19
findings (versus a full main turn of ~31.7k+ input). The continuation carries full
context in both cases — it is never a "dozens-of-tokens bare turn".

**Consequence for the "tokens saved" headlines.** The mechanism worth quoting is the
skipped *call count* (`skippedLlmCalls` is exact). Token magnitudes — §6's `~1130`, and
the side-turn `llmInputTokens` here (521–7,381) — are all *sub-figures* of the true
continuation cost once `cacheRead` is counted: one elided subagent continuation is a
~16.7k-token prompt, and a full agent turn (§9) is 20k–160k. The dedup saving is best
stated as "1 subagent continuation (~16.7k prompt tokens incl. cache) elided", not
merely the 521-token uncached delta.