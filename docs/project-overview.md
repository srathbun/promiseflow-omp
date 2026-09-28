# Aristotle × PromiseFlow — Project Status

> Where we are, what the project is, and what's next. Working snapshot; last updated to the close of the 18.3.2 live-dedup run (verification-bundle §10).

## What this project is

The question being answered:

> Can a deterministic, shareable unit of *parser work* be identified from an OMP agent's reasoning, so that **multiple subagents coincidentally doing the same work run it once**?

Two pieces play together:

- **Aristotle** (`F:\aristotle`) — an OMP extension exposing a **Marpa::R2 generalized parser** as the `reason` tool. Grammars are versioned and rewritten at runtime (`create`/`extend`/`fork`/`commit`), and **ambiguity is first-class data** (`VALID` / `AMBIGUOUS` / `INVALID` plus the parse-forest count and renditions). Marpa being a *generalized* parser (Earley/GLL, not LALR) is the point: it accepts deliberately **vague grammars** and reports a forest instead of rejecting them.
- **PromiseFlow** (`F:\promiseflow-omp\extensions\pf-coordinator\promiseflow`) — a TypeScript port of PromiseFlow's **single-flight coordination**: `Coordinator.getOrRun(key, work)` runs `work` once when callers collide on `key` and lets followers await the shared result, with retention/retry/Redis variants.

The bridge is a **segment key**: `stableHash(grammar, ordered fragment prefix)`, computable *before* the parse runs. Two sessions reaching the same `(grammar, prefix)` hand the parse to one coordinator instance and share a single execution.

## Architecture (the layering we arrived at)

```
OMP                       owns agent/session lifecycle (untouched)
  └─ Tool call → parse     one tool boundary; tool.execute is the hold/pause point
Aristotle                 grammar construction + ambiguity + Ruby Slippers (extend→reparse)
  └─ Marpa worker (perl)   performs the actual parse (stateless `parse_once` / stateful ops)
Segment identity layer    segmentKey(grammar, prefix) — deterministic, pre-computed
PromiseFlow               Coordinator.getOrRun — in-flight dedup of the parse
```

## What's been built (chronological)

Pre-existing (inherited): the `reason` tool and Marpa worker in Aristotle; the PromiseFlow TS port and the `pf-coordinator` extension.

### M14 — incremental turn parsing (`F:\aristotle`)
- `src/turn-parser.ts`, `src/turn-parser-extension.ts`, `tests/turn-parser.test.ts`.
- Feeds a completed assistant turn into the parser at `message_end`, persists per-agent state through `appendEntry`/`getBranch`, injects a parser summary at `context`.
- Proved the no-core-change loop: response → parse → state → next turn, state surviving across turns and worker respawns (dangling-else, 3→3→1).

### M15 — the parser prefix as a segment (`pf-coordinator/experiments/`)
- Added stateless **`parse_once(grammar, fragments)`** to `F:\aristotle\worker\marpa-worker.pl` (the minimum change to decouple a parse from the worker's persistent `%STATES`).
- `segment-key.ts`, `marpa-client.ts`, `segment-coordinator.test.ts`.
- Proved single-flight: 2 concurrent callers → 1 execution, owner/follower split, plus shared-failure/no-poison/retry.

### M16 — coordination audit (no code)
- `F:\promiseflow-omp\docs\aristotle-omp-loop-hook.md`.
- Three questions answered with source citations:
  1. **Visibility** — `tool_result` sees the full forest (`details`) before the next model call.
  2. **Holding a turn** — already possible at the tool-`execute` boundary (the follower-wait); the `tool_call`/`tool_result` *hooks* are 30 s-bounded, so they're the wrong place to hold.
  3. **Acting across agents** — **not reachable** from extension hooks today (no peer-steer, no spawn, no cross-session context injection). Minimum OMP core change identified: expose `steerPeer` + `spawnTask` to extension context.

### Path (i) — held resolve loop (`pf-coordinator/experiments/`)
- `grammars.ts`, `resolvable-parse.ts`, `resolve-coordinator.ts`, `segment-resolve.test.ts`.
- `resolvePrefix`: detect ambiguity → **hold** on a decision deferral → **extend grammar** → re-parse. Wrapped by `coordinatedResolve` behind a segment key. Ambiguous expr grammar → precedence grammar: **2 → 1** (and 14 → 1), under contention the whole loop runs once.

### Step 2 — process-wide shared coordinator (`pf-coordinator/experiments/`)
- `parse-segment.ts` (module-scoped `Coordinator` + worker + `DEFAULT_GRAMMAR` + counters), `parse-segment-extension.ts` (the LLM-callable **`parse_segment`** tool + prompt template), `parse-segment.test.ts`.
- Key correctness point: the coordinator lives at **module scope**, so every subagent rebind shares one instance (module graph is evaluated once per process).

### Step 3 — real subagent run (SQLAlchemy #13497)
- Two identical subagents extracted findings from a real GitHub issue. **Loose schema → diverged** on two boundary judgments; the v1 `finding+` grammar produced an exponential **2^(n−1)** vacuous forest (16 384 / 32 768 interpretations).
- Fix: **v2 `TYPED_GRAMMAR`** (`temporal | marker`, structured ambiguity) + a **tight deterministic schema** (atomize dotted identifiers at `.`, explicit include/exclude). Result: agents **converged byte-identically**; forest bounded at **2^5 = 32** (five temporal tokens); dedup fired (2 requests → 1 execution).

## Key findings (the durable takeaways)

1. **Dedup identity is exact.** The segment key hashes `(grammar, prefix)` byte-for-byte. It dedupes *in-flight* computation, not "similar" work (no fuzzy/semantic matching, by design).
2. **Convergence is a schema property, not a prompt property.** Two agents only collide if fragments are a *deterministic function of task state* with a fixed canonical order. Prose "sort and dedupe" instructions do not suffice (measured divergence on qualified-vs-unqualified naming and symbol scope); a tight atomizing schema does (measured byte-identical convergence).
3. **Ambiguity must be structured, not lexical and not partition-noise.** Lexeme overlap silently collapses under Marpa's longest-token-matching; an unstructured `X+` grammar turns the forest into exponential regroupings. Structured ambiguity (temporal-type vs generic-mention) is bounded and meaningful.
4. **The hold/replace/reparse "Ruby Slippers" loop is already expressible** as a stateless work factory (`parse` → `extend` → `parse_once`), and is itself a single-flight-coordinated segment.
5. **Cross-agent coordination is a roadmap item, not a current capability.** Extension hooks can hold/steer the *current* agent only; steering a peer or spawning a resolver requires a small OMP-surface addition (`steerPeer`/`spawnTask`), or is only reachable model-mediated (inject content that makes the model call `task`/`hub`).

## Test status (all green)

| Suite | Result |
|---|---|
| promiseflow-omp `bun test` | **83 pass / 0 fail** (13 files) |
| promiseflow-omp `tsc --noEmit` | exit 0 |
| aristotle `node --test` | **39 pass / 1 skip** (pre-existing headless smoke) / 0 fail |
| aristotle `tsc --noEmit` | exit 0 |

## What's open / not done yet

**Now done (since the step-3 run):**

- **Live OMP-runtime run with real usage** — `parse_segment` + `reason_segment` both exercised in a live `omp/18.3.2` session with the extension loaded; two concurrent subagents at the same `(grammar, fragments)` state produced one execution, one `skippedLlmCalls`, and a real `assistantMessage.usage` delta (521 in / 794 out → 0/0 for the follower). Full ledger in verification-bundle §10. (`reason_segment` required `ctx.runEphemeralTurn`, absent before 18.3.0 — that was the prior "no LLM primitive" dead-end.)

**Still open (in paper-priority order):**

- **Collision rate at N>2** — the *mechanism* is proven (same key → one execution, N≤3 exercised); the *rate* is unmeasured. A paper claiming "multiple subagents coincidentally doing the same work run it once" needs an experiment over a real multi-agent workload counting how many distinct segment keys repeat, not just proof that a forced collision dedups.
- **Cross-agent / in-loop surface** — `steerPeer`/`spawnTask` or an `after_agent_step` hook. Today dedup only fires when two agents *happen* to reach the same state concurrently (model-mediated); actually skipping the in-loop provider call (rather than a coordinated side turn) still needs the core-hook change. This is the paper's central "future work."
- **Cross-process dedup** — in-flight dedup is single-in-process only; `RedisCoordinator` (already ported) is never exercised across processes/sessions.
- **Generalization breadth** — 2 issues, 1 extraction shape (symbol lists), 1 grammar (`temporal | marker`). The paper claims the mechanism + convergence phenomenon; a general "extraction" claim needs more shapes.
- **`execute_once`** — stateless semantic-action execution for grammars that *compute* (`vars`/`output`) rather than recognize. Low paper relevance (the thesis is recognition + ambiguity).
- **Lexeme-identity rendering** — worker prints matched text, so `temporal`-vs-`marker` alternatives render identically (forest count still honest). Cosmetic.

## File map

```
F:\promiseflow-omp\
  docs\aristotle-omp-loop-hook.md        M16 audit (OMP lifecycle)
  extensions\pf-coordinator\
    index.ts                             pre-existing: wraps read-only tools with Coordinator
    promiseflow\                         pre-existing TS port (Coordinator, RedisCoordinator, keying, …)
    experiments\
      segment-key.ts                      M15  segment identity
      marpa-client.ts                     M15  minimal stateless parse_once client
      segment-coordinator.test.ts         M15  single-flight + failure tests
      grammars.ts                         Path(i) ambiguous + precedence expr grammars
      resolvable-parse.ts                 Path(i) detect→hold→extend→reparse
      resolve-coordinator.ts              Path(i) coordinatedResolve
      segment-resolve.test.ts             Path(i) tests
      parse-segment.ts                    step2 process-wide coordinator + DEFAULT/TYPED grammars
      parse-segment-extension.ts          step2 parse_segment tool + prompt template
      parse-segment.test.ts               step2 dedup tests

F:\aristotle\
  worker\marpa-worker.pl                  includes parse_once (added M15)
  src\extension.ts                        pre-existing reason tool
  src\turn-parser.ts, turn-parser-extension.ts   M14
  tests\turn-parser.test.ts               M14
```