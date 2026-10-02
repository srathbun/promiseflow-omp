# Aristotle × PromiseFlow — Project Status

> Where we are, what the project is, and what's next. Working snapshot; last updated to the close of the paper-draft experiments (grammar-authoring, TTL retention, schema-free collision) and the draft restructure after external review.

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

### Meta-review round (ChatGPT) → punch-list execution
- **Grammar-in-key contract** (`segmentKey.prompt` + grammar already in the hash): two agents with different grammars get different keys — no dedup. Pinned with two tests (`parse-segment.test.ts`): same findings+prompt but `DEFAULT_GRAMMAR` vs `TYPED_GRAMMAR` → distinct keys, two LLM calls, no follower; plus a `segmentKey` grammar-identity test.
- **Ambiguity ≠ uncertainty** wording: the parse count exposes unresolved distinctions in the *representation*, not the agent's uncertainty (a grammar recounting the same fact 262,144 ways says nothing about the agent).
- **Semantic-caching contrast** added to "Where this sits": vCache's probabilistic similarity contract vs this paper's lossless declared-identity contract. Three citations verified and added (vCache arXiv:2502.03771 ICLR 2026; KVFlow arXiv:2507.07400 NeurIPS 2025; KVCOMM arXiv:2510.12872 NeurIPS 2025).
- **Prevalence probe** (§ collision-rate tier): 6 independent agents listed every quantitative claim under a shared token schema → 142 line-items, 27 distinct values, only 3 (262144 / 32 / 19) found by all six; list lengths 13–45. First evidence the "shared core, divergent boundary" pattern is a property of extraction tasks generally, not just the two earlier cases.
- **Cross-task prevalence probe** (real SQLAlchemy issues #2501/#7366/#6874/#10742/#9233/#11677): 6 agents, each on a *different* issue, one shared symbol grammar, no shared schema. 5 usable lists (1 derailed), 83 line-items, 65 distinct symbols, only 3 (column/metadata/table) found by ≥3 agents, none by 4, 51 unique to one issue. Verdict: **confirms scope, not a negative** — different tasks share almost nothing (trivially), so the paper is about *shared* work by definition. The still-open number is the rate at which a broad shared ask (same codebase read/re-read by many agents) repeats the same piece of reasoning.

### Paper draft + evidence experiments (`docs/paper-draft.md` + `experiments/`)
- Paper, *The Work Already Done: Parsing and Promises for Collaborative Agents*, drafted in the author's voice against the original *Parallel Processing with Promises* paper. Restructured after an external (Claude) review: Purpose/Problem block up front, related work ("Where this sits") moved up, new "When does this fire?" preconditions section, a System section with figure, and the evidence split into strength tiers (proven / solid / weak / anecdotal) with per-result caveats.
- **Grammar-authoring run** (model writes `finding+` then refines to `temporal|generic`): 19 SQLAlchemy tokens → naive grammar reported **262,144** readings; the model diagnosed "pure regrouping, no information" and rewrote to the typed grammar → exactly **32** (2^5). This is the measured trace behind the paper's "the model writes the grammar" claim (previously near-neighbor analogy).
- **TTL retention demo** (`ttl-retention-demo.ts`): Ephemeral → 2 sequential callers / 2 executions; `Ttl(60)` → 2 callers / 1 execution (the later caller skips). Backs the "retention relaxes the overlap precondition" clause.
- **Schema-bound collision** (`reference-collision.ts`): 4 identical-prompt, shared-schema extractors → 25 requests / 13 distinct / 12 absorbed (0.48 duplicate fraction).
- **Schema-free collision** (`schema-free-collision.ts`): 4 extractors, *no* shared schema → mechanical collision rate 0.08 (24 distinct strings from 26 items) vs conceptual 0.67 (12 works, same 4 at the core). The 0.08→0.67 gap is the schema's measured contribution. (One extractor derailed and returned no list — a real unprompted-extraction failure mode.)

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

**Now done (this session — paper draft + evidence experiments):**

- **Grammar-authoring run** — a subagent wrote the naive `finding+`/`item+` grammar, saw the 262,144-reading forest, diagnosed it as regrouping noise, and rewrote to `temporal | generic`, landing on exactly 32 (2^5). This converts the paper's "the model writes the grammar" claim from analogy to a measured trace on the create/extend surface (§ "The loop the model writes").
- **Schema-free collision run** — 4 extractors, no shared schema: mechanical collision 0.08 vs conceptual 0.67 (same 4 works at the core). The gap is the schema's measured contribution; one agent derailed and returned no list. Reported in § "Collision rate", now a two-sided anecdote rather than schema-bound-only.
- **TTL retention demo** — Ephemeral 2→2 executions; `Ttl(60)` 2→1 (sequential second caller skips). Backs the "When does this fire?" retention clause.
- **Paper draft restructured** after external review — Purpose block, related work moved up, preconditions section, system figure, tiered evidence.
- **Grammar-authoring cost instrumented** (post external-review punch item): the LLM's spend *writing* the grammar is now measured — Aristotle `reason` `create`/`extend` charges `grammar_author_tokens`, and the segment path charges a non-shipped `grammar` arg into `grammarAuthorTokens` (once per distinct source, chars/4). `runScenario` reports `grammarAuthorTokens` and `netTokensSaved = saved − authoring`, so the paper's net-savings claim is stated against the one-time authoring setup the savings must clear.

**Still open (in paper-priority order):**

- **Collision rate at scale** — all collision work is four agents, one corpus, schema imposed or withheld deliberately. A real rate across a live multi-agent workload with independent tasks remains unmeasured; the paper says so (§ "What we have not done").
- **Cross-agent / in-loop surface** — `steerPeer`/`spawnTask` or an `after_agent_step` hook. Dedup still fires only on concurrent same-state arrivals; skipping the in-loop provider call needs the core-hook change (paper's "loop surface" limit).
- **Cross-process dedup** — in-flight dedup is single-in-process only; `RedisCoordinator` (already ported) is never exercised across processes/sessions.
- **Generalization breadth** — 1 extraction shape (symbol lists), 1 grammar (`temporal | marker`), 2 issues. The paper claims mechanism + convergence; a general claim needs more shapes (§ "breadth of shape").
- **`execute_once`** — stateless semantic-action execution for grammars that *compute* (`vars`/`output`) rather than recognize. Low paper relevance; cut from paper scope per review.
- **Lexeme-identity rendering** — worker prints matched text, so `temporal`-vs-`marker` alternatives render identically (forest count still honest). Cosmetic; cut from paper scope per review.

## File map

```
F:\promiseflow-omp\
  docs\aristotle-omp-loop-hook.md        M16 audit (OMP lifecycle)
  docs\paper-draft.md                    paper draft (thesis/body/conclusion/references)
  docs\verification-bundle.md            evidence pack (M15 → step 3 → live LLM step)
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
      parse-segment-extension.ts          step2 parse_segment/reason_segment tools
      parse-segment.test.ts               step2 dedup tests
      sqlalchemy-scenarios.ts             step3 issue #13497/#13570 harness (runScenario)
      reference-collision.ts              schema-bound collision measurement (0.48)
      schema-free-collision.ts            no-schema collision measurement (0.08 vs 0.67)
      ttl-retention-demo.ts               TTL vs Ephemeral sequential-caller demo (2→1)

F:\aristotle\
  worker\marpa-worker.pl                  includes parse_once (added M15)
  src\extension.ts                        pre-existing reason tool
  src\turn-parser.ts, turn-parser-extension.ts   M14
  tests\turn-parser.test.ts               M14
```