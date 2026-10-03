# Segment Allowance — a measurement plan for "how often do we actually find segments?"

> Working note. Companion to `paper-draft.md` §"What we have not done" (the *rate at which
> shared work repeats*). The question this answers: for parallel agents working a shared
> corpus under a shared schema, what fraction of their reasoning segments are repeats — and
> can we predict that number before we pay the swarm to run?

## The question, made concrete

A *segment* is a named unit of reasoning: the pair `(grammar, ordered fragment prefix)` hashed
into a segment key. The whole design rests on segments repeating. What we do not yet know is
**how often they do**, as a number rather than a handful of anecdotes.

Define the number we want — the **segment allowance**:

```
collision rate = (total segment occurrences − distinct segment keys) / total occurrences
```

If a swarm of N agents produces T segments and only D distinct keys, then `T − D` occurrences
were repeats, and `1 − D/T` is the dedup fraction. That fraction, as a function of swarm size,
task-overlap structure, and schema granularity, is the missing measurement.

The measured point-estimates so far (all N=4):

| workload | collision rate | note |
|---|---|---|
| schema-bound reference extraction | 0.48 | shared schema, one task |
| schema-free reference extraction | 0.08 mechanical / 0.67 conceptual | the gap is what the schema buys |
| cross-task SQLAlchemy (different issues) | ~0 | different tasks share almost nothing |

Those are three corners. The plan below generalizes the measurement and adds a predictive
model, so the number becomes something we compute rather than something we collect one run at
a time.

## Method A — measure it directly (the "tests")

The key is already computed for free before every expensive step; instrumenting that moment
turns the collision rate into a byproduct.

1. **Key-level trace.** Extend the existing `segmentStats`/`dedupSavings` counters (which
   already track `requests`/`owners`/`followers` at the coordinator level) with a *trace of
   individual keys*: on every `parseSegment`/`coordinatedReason` result, record the key, its
   grammar version, its fragment-prefix length, and a timestamp. Keep a multiset, not just a
   set. (This is a small addition to `parse-segment.ts` — the data already flows through it.)

2. **Two numbers per run.** From the multiset, emit:
   - `total` and `distinct`, hence `collision rate = 1 − distinct/total`;
   - a **occurrence histogram** — how many keys appear once, twice, … k times — which is the
     whole distribution, not a single point estimate.

3. **Split overlap from retention.** A key seen twice *concurrently* is the in-flight dedup the
   `Ephemeral` retention already catches. A key seen twice *sequentially* is only caught by a
   time-to-live retention. The trace must record the arrival-time **gap** between repeats, so a
   run reports two rates — in-flight and retention-window — not one blurred number. This
   directly answers "how much does TTL relax the overlap precondition" with a distribution
   instead of the single 2→1 demo.

Deliverable: a `runScenario`-style harness that takes a workload + concurrency + retention
policy and prints `total / distinct / (in-flight / retention) collision rates / occurrence
histogram`. No new theory — pure measurement.

## Method B — predict it (the "math")

The measured shape so far is consistent everywhere: a small shared core every agent hits, plus
a long tail of divergence. That is the signature of a heavy-tailed distribution over segments.
Model the population of segment types as:

```
p_i ∝ i^(−α)      (Zipf / power-law over segment types, ranked most-common first)
```

with `N` agents, `M` segments each, `T = N·M` total draws. Two standard facts give the answer.

**Distinct count.** A type with frequency `p` is seen by at least one of `T` independent draws
with probability `1 − (1−p)^T`, so the expected number of distinct keys is

```
D = Σ_i [ 1 − (1 − p_i)^T ]
```

and the expected repeats are `T − D`.

**Where the repeats live.** Split the sum at the point where `T·p_i ≈ 1`:

- **Head** (`T·p_i ≫ 1`): the type is essentially always seen — contributes ~1 distinct key and
  `~T·p_i − 1` repeat occurrences.
- **Tail** (`T·p_i ≪ 1`): `1 − (1−p_i)^T ≈ T·p_i`, so it contributes ~`T·p_i` distinct keys and
  ~0 repeats — singletons.

So the collisions concentrate in the types with `p_i ⪆ 1/T`, the "shared core." Under Zipf,
`p_i ∝ i^(−α) = 1/T` at rank `k* ≈ T^(1/α)`, so the core grows as `T^(1/α)` — more agents and
segments (or a leaner tail, smaller α) mean a larger core and more collisions. The dedup
fraction `1 − D/T` is then dominated by the head, and it is a closed form in `α` and the swarm
and segment counts.

This is the prediction lever: **fit α once** (from the occurrence histogram of any run) and the
model forecasts the collision rate for a *different* swarm size or retention window before that
run is paid for. Two caveats belong in the plan, not in the small print: the power law is a
hypothesis to fit, not an established law of agent reasoning; and `M` is not equal across
agents, so the model's next refinement folds in the variance of per-agent segment counts.

## Three workloads that would stress the model three ways

Each is a real "is the same piece of reasoning repeated?" case, chosen to vary the *shape* of
sharing (chain / disconnected / sub-segment) rather than repeat the two symbol-extraction runs
we already have.

### W1 — SQLAlchemy issue sweep (disconnected sharing)

The closest to the existing corpus, scaled. Take a window of real SQLAlchemy GitHub issues and
run parallel agents through them under the fixed token schema + `TYPED_GRAMMAR`, recording
finding-symbol segments and `reason_segment` continuations. Vary the **overlap structure**:

- *disjoint* — each agent a different issue (confirms the ~0 boundary);
- *focused* — all agents the same issue from different directions (expect high);
- *clustered* — agents on issues touching the same dialect/component (the interesting middle).

Measure the collision rate per configuration and let the trace report the recurring symbols and
files automatically. Deliverable: a **segment-allowance curve** — dedup fraction as a function
of task overlap — for one real codebase.

### W2 — choose-your-own-adventure co-authoring (chain + sub-segment + prose)

Tests the "breadth of shape" limit: the shared output is *generative prose*, not extracted
symbols. A branching narrative where each agent writes one node; the grammar names the *state*
a node must stay consistent with — the prior beats it links to, the plot variables it reads or
sets, the character states it must keep straight. The shareable segment is the
"reconstruct the story so far" derivation every writer performs before it writes. Two things
fall out at once: the ancestor chain is a **chain** of segments (each node's key prefixes its
descendants), and the story-so-far reconstruction recurs across sibling branches as a
**disconnected/sub-segment** that the trace should surface. Measure how much of that
reconstruction repeats, and whether the grammar stays stable across writers.

### W3 — UI test repetition (disconnected, high-value, mundane)

The friend's case: agents automating UI tests that get "bogged down repeating already-done
tests." Segment = a deterministic action/assertion path ("reach state X, click Y, assert Z"),
keyed on the path. Measure the duplicate-path rate and the arrival-time gap, so the run reports
how much of the two hours was the *same* interaction re-run and how much was genuinely new
coverage. This is the least glamorous workload and the one with the most obvious payoff: if the
mechanism can say "we already tested this," that is the anecdote turned into a number.

## Notice sub-segments (cross-cutting)

The "shapes of sharing" section promises the mechanism *carries* sub-segments but does not yet
*notice* them. The noticing is a one-pass analysis of the key trace that needs no new mechanism:

for every key `(G, f1..fn)`, every prefix `(G, f1..fk)` for `k = 1..n` is itself a valid segment.
Count the prefixes across all keys; any prefix that recurs under many *different* full keys is
a shared sub-segment. This is a trie over the ordered fragments, and emitting its edge weights
turns "find the shared core inside distinct flows" into output rather than a question. It is the
capability a model would use to say "every path through this corpus begins by reconstructing the
same state" — the exact thing W2 and W3 want to detect.

## What each number would settle

- A collision rate above ~0 under *disjoint* tasks would contradict the scope claim and send us
  back; ~0 confirms it and lets the paper rest the boundary on data.
- A collision rate that rises smoothly with overlap structure (W1) gives the paper its first
  *curve*, not its fourth point.
- A non-trivial repeat rate on *prose* (W2) and on *test paths* (W3) is what moves the claim
  from "symbol extraction" to "reasoning generally" — the breadth-of-shape limit, answered.
- A fit α that predicts a second run's rate within tolerance is what turns the collision rate
  from a retrospective into a forecast — the difference between "we measured it" and "we can
  plan around it."

Order of attack: build the Method-A trace harness first (it is a few dozen lines on top of what
exists), then W1, because it is the corpus we already have and it exercises the harness; W3 and
W2 follow, because they extend the *shape* rather than the machinery.

## Status — built vs. executed

| Step | State |
|---|---|
| Method A — key trace (`segmentTrace()`: total/distinct/collision/histogram) | ✅ built, wired into `parseSegment`/`coordinatedReason`, unit-tested |
| Retention caching (Ttl) on the segment coordinator | ✅ built — `SEGMENT_TTL_SECONDS` (default 60s, `0`=Ephemeral); `cacheHits` counted in `dedupSavings` |
| Redis cross-process/cross-time cache | ✅ built and **executed** — `redis-segment-demo.ts` shows a fresh coordinator reuse a persisted value with `executions=0` against the local Redis |
| Turn chunking (`splitTurn`) | ✅ built — tool args canonicalized; `flowsSharing` reports whole-turn vs. chunked |
| Per-step variant (`parseSegmentSteps`) | ✅ built — keys `(grammar,[step])`, capturing the disconnected sharing the prefix identity misses |
| Sub-segment noticing (`recurringSubsegments`) | ✅ built — contiguous shared runs at any position, not just from the start |
| Method B — forecast (`segment-allowance.ts` `forecastCollision`) | ✅ built + unit-tested; caveat: i.i.d. ceiling over-predicts structured flows |
| W1 SQLAlchemy sweep | ✅ **executed** — 5 agents over 5 real issues (results below) |
| W2 choose-your-own-adventure | ⬜ **not executed** (needs a shared prose grammar + agents) |
| W3 UI test repetition | ⬜ **not executed** (needs a UI harness) |
| Long-horizon convergence (multi-turn loop) | ✅ **executed** — 3 fix agents over 103 turns (results below) |

The remaining probes need live model-backed agents: W2/W3 against a corpus or harness, and the
long-horizon probe against a multi-turn loop — compute, not code. W1 and the single-turn curve
ran against the built harness.

### W1 result — measured

Five independent agents extracted finding-symbols under the shared schema (`w1-findings.json`,
`sqlalchemy-sweep.ts`): two on issue #13497 (focused), one each on three SQL Server reflection
issues (#10504, #8035, #7415), plus the two saved reference extractions (#13497, #13570).

| config | flows | whole-turn collision | per-symbol collision | shared core |
|---|---|---|---|---|
| disjoint (#13497 reflection vs #13570 pool) | 2 | 0.00 | **0.03** | `create_engine` only |
| clustered (4 SQL Server reflection issues) | 4 | 0.00 | **0.36** | `MetaData`, `Table`, `create_engine`, `sys` (all 4) + the reflection machinery (`get_columns`, `reflect_table`, `identity_columns`, `is_identity`, `seed_value`, `_switch_db`, `_execute_on_connection`, …) |
| focused (3 agents on #13497) | 3 | 0.00 | **0.55** | the 19-symbol bug core (`Column…` `sys`) shared by all three; divergence only in reproduction-code locals (`d2`, `t`, `tm`, `pyodbc`, `exec_driver_sql`, …) |

Reading: whole-turn (ordered full-list) dedup is **0 everywhere** — no two agents byte-converged,
so the coordinator keyed on the full list would coalesce nothing here. The saving lives at the
*per-symbol/per-step* level, where the collision rate tracks overlap cleanly: ~0 for different
subsystems, ~0.36 within one subsystem, ~0.55 for the same issue. The three focused agents agreed
on exactly the 19-symbol reference core and diverged only on the boundary — a measured N=3/N=4
reproduction of the paper's "shared core, divergent boundary." This is precisely the case the
`parseSegmentSteps` per-step variant captures and the whole-turn key does not.

**Convergence is the schema, not the prompt (tight re-run).** The same focused config re-run with
a *strict* schema (explicit include categories + an explicit exclude list) closed the gap:

| config | whole-turn collision | symbol-set convergence | byte-identical to reference |
|---|---|---|---|
| focused, loose schema | 0.00 | no (37 distinct symbols) | 0/3 |
| focused, STRICT schema | **0.33** | **yes — all 3 → the 19 symbols** | **2/3** |

Under the strict schema every agent landed on the identical 19-symbol set, and 2 of 3 were
byte-identical. The one miss is instructive: it diverged only in *ordering* — it put the
leading-underscore `_parse_column_info` before the uppercase block instead of between uppercase
and lowercase. Because the segment key hashes the *ordered* list, a sort rule the schema leaves
ambiguous is itself a convergence killer. The anchor for the savings-model's `convergence`
parameter is now measured: **0 under a loose schema, ~0.67 (byte) to 1.0 (set) under a strict one**
— and the residual gap is fixable by pinning the lexicographic rule to raw byte order.

**Scaling the convergence rate (5 issues, 11 agents).** The focused 2/3 was not representative: it was
one issue whose symbol vocabulary is crisp. Running the same strict schema across 5 real issues and
11 agents, pooled by a pairwise reporter (`convergence-rate.ts`, `w1-findings-rate.json`):

| metric | value |
|---|---|
| pairwise byte-identical | **1/7 (14%)** |
| pairwise set-identical | **3/7 (43%)** |
| full-group byte-identical | 0/5 |
| full-group set-identical | 1/5 |

Because the explicit raw-byte sort rule was now followed, the residual divergence is the *symbol set*
(which boundary identifiers to include), not ordering. Reading: the segment key dedups on byte-
identical ordered lists, so the relevant convergence for the savings model is ~14%, not the 67% the
single-issue run suggested. The mechanism fires on roughly one in seven redundant doings under a
generic strict schema — low, and the honest answer to "is it worth it." The one issue that did
converge (#13497) is the case where a task-specific vocabulary is crisp; whether a model-authored,
per-task schema can drive that rate toward 1.0 at scale — and at what authoring cost — is now the
precise open question, and it is a schema-authoring question, not a token question.

**Convergence vs schema tightness (the curve).** Escalating the schema on the same issue, three
agents per level (`convergence-curve.ts`, `curve-l2-*.json`):

| issue | level | pairwise byte-identical | pairwise set-identical |
|---|---|---|---|
| #13497 | L0 loose | 0% | 0% |
| #13497 | L1 strict | 33% | 100% |
| #13497 | L2 very strict | 33% | 33% |
| #13570 | L1 strict | 0% | 0% |
| #13570 | L2 very strict | 33% | 33% |

Byte-convergence **plateaus at ~33%**: tightening the schema past "strict" does not push it toward
1.0 — one of three agents still diverges, every level, on 1–2 boundary symbols (`CreateTable`,
`get_raw_connection`, `raw_connection`). Worse, tightening *shifts the target*: at L2 the agents
agree the symbol list is smaller (14 vs 19), so even set-convergence *drops* as the schema narrows
which names count. The residual divergence is irreducible judgment — the boundary between
"finding-symbol" and "reproduction scaffolding" is fuzzy and no prose schema pins it. The only way
to force 100% is full enumeration — a template that names the answer — at which point the model's
"naming" is no longer independent reasoning, and the setup cost approaches doing the work.

This is a **single-turn, frozen-schema floor — not a ceiling.** The design never assumed a
written-once schema: it uses Marpa ambiguity precisely to refine the grammar *lazily*, defining
only the parts a problem engages, and only when they are hit. A one-shot extraction with a static
grammar cannot see that, so ~1/3 is where convergence sits at turn 0, before the loop has run.
Whether convergence *rises with engagement length* is the open question, and it is the next
measurement, not this one.

### Long-horizon hypothesis & probe

**Hypothesis.** Byte-convergence rises with the number of turns, because the grammar is refined
in-loop and co-walkers that hit the same ambiguity converge on the same refinement. The grammar is
also the vocabulary constraint: a token the refined grammar rejects (reproduction scaffolding)
returns INVALID, so an agent drops it — and two agents independently chase the same valid subset,
washing out the extraction divergence measured above.

**Probe (needs a live multi-turn loop).** Take a long, multi-part problem — 2-hour-scale, many
sub-decisions — not one issue. Two or more agents each run the loop: emit findings → `parse` →
read AMBIGUOUS/INVALID → `extend` the grammar where the boundary is load-bearing → reparse, all
from a deliberately loose `doc ::= finding+` grammar. Measure per turn t: (a) *grammar
convergence* — do the agents' grammars byte-converge on the shared parts? (b) *segment collision*
— do their `(grammar, findings)` keys collide? (c) the *stabilization turn* — where convergence
saturates. The prediction: collision rises over t toward the refined scope's ceiling, not the
turn-0 floor of ~1/3. This is the loop the paper's grammar-authoring run exercised once for one
agent; the missing number is whether it *converges across agents over a long problem*.

### Long-horizon result — measured

Three agents each implemented overlapping real fixes in the cloned `sqlalchemy` (identity seed,
precision, collation, reflection hang — all in `dialects/mssql/base.py`), over a genuine multi-turn
edit loop (`long-horizon.ts`, `long-horizon-findings.json`):

| agent | turns | engaged symbols |
|---|---|---|
| FixA (identity + precision) | 30 | 29 |
| FixB (precision + collation) | 46 | 30 |
| FixC (collation + hang) | 27 | 22 |
| **total** | **103** | 52 distinct |

Cross-agent convergence on the component vocabulary: **26 of 52 symbols shared by ≥2 agents (50% of
the union)**, with pairwise Jaccard tracking the assignment overlap (FixA∩FixB 0.31, FixB∩FixC 0.41,
FixA∩FixC 0.06 — the unassigned pair). The shared core is exactly the reflection machinery
(`get_multi_columns`, `_parse_column_info`, `identity_columns`, `seed_value`, `increment_value`,
`collation_name`, `sys_columns`, `sys_schemas`, …).

The decisive number is the **shared core vs. turn** — it accumulates monotonically:

```
turn  1 →  1 shared symbol
turn  4 →  2
turn 10 →  4
turn 13 →  8
turn 16 → 13
turn 22 → 18
turn 28 → 25
```

A one-shot probe sees ~1 shared symbol (the turn-0 floor); the full ~30-turn task reveals 25. This
is the missing interaction: convergence *emerges over turns* as code-grounded agents re-engage the
same component, and it is invisible to the short, static extraction probes that measured 33%. The
hypothesis holds at first approximation — the value is in the long horizon, not the schema.