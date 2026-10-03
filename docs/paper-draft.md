# The Work Already Done: Parsing and Promises for Collaborative Agents

### Spencer Rathbun (with the Aristotle × PromiseFlow collaboration)

> DRAFT — working document for collating the paper.

## PROBLEM AND CONTRIBUTION

Multi-agent coding and research teams waste the same reasoning on the same material — two
agents reading one failing trace, four agents re-deriving one assumption — each paying for a
model call that another agent has already made. A *full agent turn* runs on the order of
twenty thousand to one hundred and sixty thousand tokens before any caching; the smaller
continuation this work deduplicates runs about sixteen thousand. This paper gives those teams
a mechanism they can build and keep
using: name a unit of reasoning *before* it runs, so agents doing the same unit while it is
underway run it once — a guarantee that holds while their requests overlap, or by a retention
policy when they do not. It reports, in numbers rather than promises, when that mechanism actually fires, and it
says straight what it does not yet do: suppress the agent's own primary model call.

What this paper is about, and what it is not, is worth saying once, at the front. It is about
*shared* work: agents whose material overlaps — the same trace, the same symbol, the same
dependency — doing a piece of reasoning more than once. It is **not** about wholly different
tasks. An agent mowing a lawn and another doing laundry share almost nothing, and the fact
that they do not is trivial; nothing in this work pretends otherwise. The interesting case is
the opposite one: people working the same codebase, or agents answering the same larger
question from different directions, where a broad ask *implicitly contains many small shared
pieces* — the same context built, the same file read, the same decision reached, again and
again. Where work is genuinely shared, the mechanism pays; where it is not, there is nothing
to pay for. In short: the problem is repeated reasoning; the cost is repeated model calls; the
remedy is a name for reasoning, built by a parser; and the saving, today, is on shared
side-work, not on the agent's own call.

One thing separates this from the "just hash your work" advice that has always been obvious in
principle and never worth doing in practice: naming the repeatable unit is real labor.
Deciding what "the same work" *is* — which symbols count, which schema, which boundaries — is
the step a sensible engineer refuses, because the duplicate tokens cost less than the analysis.
This system moves that labor off the adoption checklist and into the loop. The model names the
work: it writes the grammar that defines the unit, pays the one-time cost of writing and
refining it, and that cost amortizes across every agent that later reaches the same unit. The
setup is not a precondition a human must satisfy; it is the first thing the system does for
you.

---

When a team of agents is asked to build one thing together, the most expensive thing they
do is not the work itself. It is the work twice.

Two agents reading the same failing trace both resolve the same symbol names. Four agents
checking the same assumption each re-derive it from scratch. Nothing in the system notices,
because the second agent has no way to know the first already began — let alone finished —
the identical thought. The results are paid for, token by token, once per agent. This paper
describes a small, self-contained idea that removes that waste: *parse the work before it is
run, so that identical work can be named, and named work can be run once.*

The idea leans on two tools, and only one of them is borrowed. The first is a generalized
parser — a program that reads a grammar and reports not merely whether text conforms, but
*every* way it could conform. That is Jeffrey Kegler's Marpa, in the Earley tradition, and it
is not ours. The second is our own: the single-flight coordination pattern built on promises,
described in the earlier *Parallel Processing with Promises* (Rathbun, ACM Queue 2014), which
guarantees that work bearing the same name executes once even when many workers demand it at
once. This paper is that earlier algorithm aimed at a harder object — a thought rather than a
query. The contribution is the bridge between the parser and the coordinator: a name for
*reasoning*, computed deterministically from a parse, before the expensive step begins. What
we are about to tell you is that this bridge holds — under measurement, and against real
agents' stubborn habit of disagreeing on how to say the same thing.

## WHAT WE WILL TELL YOU

We proceed in the order a reader would naturally need it. First the problem and what,
exactly, the promise pattern already buys us. Then the closest and best-known alternative —
prefix caching — and why it does not reach the thing we care about. Then the difficulty: a
thought has no ready-made name, so we must give it one. We show how parsing supplies that
name, and why a *generalized* parser matters — because ambiguity, which an ordinary parser
rejects as an error, is exactly the signal we need. We then walk one complete loop — the
model writes a grammar for what it wants to find, parses, notices where the grammar leaves
the matter undecided, holds the turn, and revises the grammar before reparsing. The model
writes the grammar — say that now and hold onto it, because it is what makes the whole thing
practical. Nobody adopting this system is handed a parsing problem to solve first. With the
pieces in hand we lay out the system itself, say when it fires and when it will not, and
report the measured evidence in tiers — proven, solid, weak, anecdotal — so the weight of
each claim is plain. We close with the limits.

## WHY IDENTICAL WORK MATTERS

Distributed work is hard for a reason that has nothing to do with clever code: nothing stops
two workers from doing the same thing, and nothing tells the second to stop. A query cache,
a build system, a web-endpoint conflation — each is a place where the answer was "make the
work expensive-safe from duplicate effort," and each needed its own bespoke guard. The
guards are hard to reason about because they ask a shared, mutable question — *has anyone
started this yet?* — at the exact moment concurrency makes the answer ambiguous.

The earlier paper showed how promises dissolve this. A promise has two ends: a *deferred*
where work happens, and a *future* where results are received. When a worker asks for a
piece of work by name, the central authority either creates a fresh deferred (the asker
becomes the owner) or hands back the future of one already in progress (the asker becomes a
follower and simply waits). Every follower attaches to the same future, so one execution
serves every demand. Failure cannot silently strand anyone: rejection flows down the chain,
and each waiting follower sees it and re-enters the claim on its own, so any one of them may
take over the work. The promise *primitive* is old — futures and deferreds long predate this
work — but the single-flight coordination built on them is the earlier paper's contribution,
and it reduces the whole coordination problem to two states a programmer can hold at once:
*working* and *waiting*.

That reduction only works, however, when the work has a name the parties can agree on. The
database query names itself by hashing its text. The build artifact names itself by its
inputs. For this kind of work, "the same name" is settled by an agreed convention, and the
coordination is nearly free. The question that motivates everything that follows is: *what is
the name of a thought?* Why not just cache the model's context, then? That question gets its
answer in the next section, and then we come back to naming.

## WHERE THIS SITS

This paper is not prefix caching, and it is worth saying where the two divide. SGLang's
RadixAttention and MemGPT's virtual memory already make repeated *model calls* cheap: when
two agents send the same prompt, the shared prefix — the re-sent system context, which is
precisely the dominant cost our measurements expose — is computed once and reused. That work
is real and shipping. What it does not remove is the *decision itself*. Two agents
whose contexts are identical still run the same continuation twice; a KV cache saves the
prefix, not the thought.

This paper works the other axis. The thing deduplicated here is the *segment* —
the grammar-shaped finding the agent has produced — so the continuation that follows it runs
once rather than once per agent. The two ideas compose rather than compete: prefix caching
makes each single flight cheap, and segment deduplication removes the redundant flights.
One is about the material a model call is made of; the other is about whether the call is
made at all. The distinction matters because a substantial share of an agent's cost can come
from the model continuations it generates — not only the context it carries back and forth —
and until a continuation has a name, no cache can prevent paying for it twice.

The closer neighbor is *semantic caching*, which asks a slightly different question: are these
two prompts similar enough that an old answer can serve a new one? That is a probabilistic,
approximate contract — the whole field's difficulty is deciding when "similar" is safe enough,
and systems like vCache exist precisely to put correctness guarantees around the match. This
paper asks a narrower, more conservative question: have two agents independently arrived at the
*same declared work*? With respect to the declared identity it is lossless — same key means
same work, different key means do not coalesce — and it is the identity the agents construct,
not a similarity an embedder guesses, that decides. The two are complementary: semantic caching
salvages near-matches, where this system asks for exact—in—declared—identity matches and never
gambles that two different things are interchangeable.

## NAMING REASONING

An agent's work is not a string in a queue. It is a chain of model calls — read, parse the
failure, decide, act — and the expensive step is hidden in the middle where the model
*reasons about text it has just produced*. If we want two agents to share that step, we need
a name that is fixed *before* the model is asked to reason, and identical whenever the two
agents are about to reason about the same thing.

We cannot hash the thought itself — it does not exist yet, and hashing its eventual output
would save nothing, since the saving is to avoid producing it. We must hash something the
agent produces that is *cheap*, *deterministic*, and *a faithful proxy for what it is about to
think*. The natural candidate is the agent's intermediate finding: the symbols, names, and
relations it has extracted from the problem so far. But raw text is a poor key — two agents
reading the same issue write "MSDialect._parse_column_info" and "_parse_column_info", or
choose a different order, and textual hashing sees two different keys where a reader sees one
judgment about the same thing.

This is the first real finding of the work: *whether two agents collide is not a property of
their prompt, but of their schema.* Give the agents a
prose instruction — "sort and deduplicate the symbols" — and they will diverge, because
dotted identifiers, qualification, and scope are real choices and each agent chooses slightly
differently. Give them a deterministic schema — atomize every dotted name at the dot, hold a
fixed canonical order — and they converge byte-for-byte. This measured divergence and
convergence is reported in the evidence section; for now hold the conclusion, because it
changes what "the same work" can mean.

## PARSING AS A NAME

If raw findings text is an unstable key, the fix is to stabilize it by structure: pass the
findings through a *parser* driven by a *grammar*, and hash the occupied structure rather
than the prose. A grammar is a small set of rules describing what a valid arrangement looks
like; a parser is the thing that takes text and reports which arrangements of the rules
produced it. In one sentence: the grammar is the form, the parse is the fill-in, and the
*parse forest* is every fill-in that fits.

Two properties matter for our purpose. The first is determinism: the same grammar and the
same ordered findings produce the same parse, so the parse — together with the grammar that
shaped it — is a name computable *before* the expensive reasoning step and *independent* of
whatever the agent goes on to conclude. The second property is the one that points away from
the ordinary, deterministic parsers found in compilers and toward the less familiar
generalized kind.

Ordinary parsers are built for languages that have been designed to be unambiguous, and when
the text is ambiguous they simply report an error. That is exactly what we cannot afford. When
two agents disagree about how a finding should be understood, we do not want an error — we
want to *know they disagreed*, in a form the system can act on. A generalized parser gives us
this: it reports not a single parse but every parse, and counts them. Where an ordinary
parser says "invalid," a generalized parser says "this input admits three readings." The
difference is the difference between a compiler and a research tool, and it is the reason the
work builds on Marpa, a generalized parser in the Earley tradition (Kegler's work; see
references), rather than on the grammar tools most programmers already know.

## AMBIGUITY IS THE SIGNAL

Ambiguity, then, is not noise. For a suitably designed grammar, the parse count exposes
unresolved distinctions in the representation — places where the grammar admits more than one
reading of the same finding. It is not a measure of how uncertain the agent is; a grammar that
recounts the same fact 262,144 times says nothing about the agent, only about itself. The
number is load-bearing when the grammar is built to make it so, and our measurements show it
takes two very different shapes, a distinction that governs the entire design.

An *unstructured* grammar — for instance "a document is a sequence of findings" with no
internal constraints — does not disambiguate anything. Every way of regrouping the same flat
list becomes its own reading, and the forest explodes combinatorially: a list of *n* findings
admits on the order of 2^(n−1) interpretations. Nineteen findings became 262,144 readings.
That is not information; it is recounting the same fact exponentially many times, and it tells
us nothing about what the agent actually decided.

A *structured* grammar — one that marks a finding as one of a small number of genuinely
distinct kinds, such as a time-type versus a generic mention — turns the same list into a
bounded question. The ambiguity becomes a count of the genuinely undecided points, and it is
small: five temporal tokens whose type could not be settled became exactly 32 readings, 2^5.
The "temporal-type" versus "generic-mention" distinction is not an ornament; in the real bug
that motivated this work it is exactly the distinction a maintainer needed to diagnose it.

Good ambiguity is structured, bounded, and meaningful; bad ambiguity is partition noise. And
this is the part that makes the whole thing practical: *nobody but the model writes either
kind.*
The grammar is not something you author by hand before adopting the system; it is an output
of the system. The forest it produces — ambiguous or clean — is feedback the model reads and
answers with a better grammar. That loop comes next, and so does the trace of it running.

## THE LOOP THE MODEL WRITES

Because the grammar tooling is exposed to the model rather than baked into the host, the loop
reaches further back than refinement: it reaches the grammar's *birth*. The same small
vocabulary — create a grammar, extend it, fork it — lets the model write the initial
description of what it wants to find, long before there is anything to refine. It reasons about
its goal, expresses that goal as rules, runs them, and reads the result. When, later, a parse
comes back ambiguous, the loop continues in the same language: notice the undecided points,
hold the turn before the next expensive step, extend the grammar with the rule that would
settle them, and reparse. This borrows an idea Kegler named the Ruby Slippers technique — the
parser can revise its own grammar in response to what it finds — applied here from the start,
so the grammar is not rescued by a human but *grown by the model*, from first draft to decision.

This sits beside the earlier claim that "agents must share a deterministic schema," and the two
need to be read together or they look contradictory. The grammar is authored by the model, but
authored *once, for the swarm*, and then held in common — not re-invented per agent. The
reason is plain in the key itself: it hashes the grammar along with the fragments, so two
agents who each write their own grammar for the same work produce two different keys and never
deduplicate, however alike their grammars read. The model owns the *birth and refinement* of
the grammar; the swarm owns its *sharing*. What the parser gives each agent is not a private
language but a common one, and the parse that follows is the checkpoint where two agents'
independent readings of the same material either meet or do not.

We watched this happen end to end on the finding-shape above. Given the nineteen SQLAlchemy
symbols and the instruction to mark the temporal kind, a model wrote a naive grammar — a
document of findings, each an unconstrained list of items — and the parser answered with
262,144 readings. The model read that count, named the failure (pure regrouping, no
information), and rewrote the grammar to split each item into a temporal literal or a generic
identifier. The same nineteen tokens parsed to exactly 32 readings, 2^5 — one binary choice
per genuinely-undecided temporal point. The refinement did not just shrink the number; it
made the number *mean* something. That first run named the answer for the model before it
began. Four more runs, unaided, are reported in the evidence: they all bounded the count on
their own, though only some found this particular distinction. The counts are reproduced
verbatim there.

The loop is a work unit like any other, which means it itself has a name and can itself be
deduplicated. Two agents arriving simultaneously at the same ambiguous state do not each run
the refine-and-reparse dance; one runs it, the other awaits the shared result. What matters
for the architecture is that this whole loop is a *stateless* work factory — parse, then on
ambiguity extend, then reparse — with no lingering state, so a holder of the turn can offer
it to a shared coordinator without worrying whose grammar is whose.

## THE SYSTEM

Here is the system in one breath, and then as a diagram so the pieces have names to point
at.

```
completed turn ──► parser (grammar G) ──► fragments f1..fn
                          │
                          ▼
        segment key = hash(scheme, G, f1..fn)     ← before any model call
                          │
                          ▼
              single-flight coordinator
          ┌───────────────────────────────┐
          │  first claimant  → owner      │ ──► runs the work
          │  (parse / continue / refine)  │      (parse, continuation, or loop)
          │  everyone else   → followers  │ ──► await the one shared result
          └───────────────────────────────┘
```

A completed agent turn is parsed by the extension. The ordered fragments and the grammar that
shaped them are hashed together into a *segment key*, computed before any model call the
segment would trigger. The key is handed to the single-flight coordinator; the first claimant
becomes the owner and runs the work — parse, or continuation, or refine-loop — while every
concurrent claimant at the same key becomes a follower who awaits the one result. The
coordination is the promise pattern from the earlier paper, wired to a key that names
*reasoning* rather than a database query.

The extension exposes two tools. `parse_segment` runs the Marpa parse behind the coordinator
and returns the forest; it is pure compute, and its dedup saves cycles, not tokens.
`reason_segment` runs the LLM continuation behind the same coordinator; its dedup is where the
token budget is actually spent less. They are deliberately separate — a parse and a
continuation at the same grammar and fragments are different work with different costs, and
were they to share a key they would wrongly collide.

What the key covers matters, and it is stated for the same reason. The parse key is the hash of
grammar plus ordered fragments — nothing more, which is why byte-different but semantically
equal findings (the loose-schema divergence) get different keys, as they should. The
continuation key adds the *prompt*: two agents at the same findings asking different questions
are doing different work and get different keys. A follower receives the owner's tool result
as its own — the same text the owner produced — so its downstream behavior is equivalent only
when the prompt was equivalent, which is exactly what the prompt being in the key guarantees.

Three design points matter because each failed in naive form before settling this way. The
first is the *process-wide* coordinator: it must live once per process, shared by every
sub-agent, or the guarantee evaporates the moment the work splits across agents. The second
is *namespacing*: a parse and a continuation at the same grammar and fragments are different
work and must not share a key. The third is the coordinator's default of *in-flight only* —
it deduplicates callers who overlap in time, and a later, sequential caller recomputes —
unless a retention policy is chosen, a one-line change whose effect is reported in the
evidence.

## THE SHAPES OF SHARING

"Shared work" is one phrase covering several different shapes, and the mechanism treats them
differently only in how a key comes to be held in common. It is worth naming the shapes,
because a person or a model holding the tool needs to know which one it is looking at, and
which of them are already guaranteed rather than merely hoped for.

A *chain* of segments is work that flows: segment two's input is segment one's output, so the
second name is computed from the first's result. The fragment-prefix identity makes this
automatic — every step of a chain is itself a prefix of the longer one, so a coherent flow is
one path through a tree of prefixes, and two agents walking the same path share every segment
on it, not merely the last. A chain deduplicates with no extra bookkeeping, because the name
already records *where in the chain* the segment sits.

A *disconnected* shared segment is the same unit reached from two different places with no
causal link between the arrivals — two agents independently extracting the same symbol list,
or re-deriving the same assumption. This is the case the collision experiments measured, and
it is the purest test of the schema: the key is the only thing that decides, and it fires when
the schema pins the findings to one string.

A *sub-segment* is a shared piece *inside* a broader flow — a step that recurs across flows
that are otherwise different, the way a "reconstruct the story so far" step recurs inside every
chapter of a branching narrative. The prefix identity already makes a sub-segment nameable —
any prefix of any ordered fragment set is itself a valid key — so the mechanism *carries*
sub-segments for free. What it does not yet do is *notice* them for you, automatically: surfacing the
common prefixes across many distinct flows — the shared core that keeps reappearing — is an analysis
of the trace of keys, and it remains unimplemented. Its *prevalence*, on the other hand, is measured
— once, on one subsystem — in the long-horizon result reported in the evidence. Naming the shapes is
the first step toward measuring which of them a real workload actually produces.

## WHEN DOES THIS FIRE?

A mechanism that works when forced is only useful if we can say when it fires on its own.
The premise itself is the first thing to state: this fires when *work is shared*. Disparate
tasks do not share, and nothing here claims they do — a measured near-zero overlap across six
real, different SQLAlchemy issues is reported in the evidence as confirmation of that
boundary, not as a finding that weakens the mechanism. The cases that matter are the ones
where a broad ask folds many small shared pieces into one — the same codebase read and
re-read, the same decision reached from separate directions. In those cases three conditions
tell when the mechanism fires, and they are what the forced demo predicts.

First, *the agents must share a deterministic extraction schema.* This is the load-bearing
one, and it is the one the prose cannot carry: without an agreed canonical form, two agents
arriving at the same finding produce different bytes, and different bytes mean different keys
— no dedup. The schema is the thing the grammar formalizes.

Second, *the agents must overlap in time, or a retention policy must bridge the gap.* With
in-flight-only retention, a caller arriving after the owner has finished recomputes; with a
time-to-live retention, a later caller within the window skips the work entirely. Which one
applies is a deployment choice, not a property of the idea.

Third, *the extraction must be coarse enough that independent agents land on the same core.*
Measured without any shared schema, three usable agents all reached the same four-work core
— four of twelve works found by every agent, eight of twelve by at least two — but named them
differently enough that the mechanical collision was near zero. The saving lives where the
schema pins the core down.

Those three are the hypothesis the collision-rate experiment, reported next, sets out to
test.

## WHAT WE MEASURED

The numbers get their own section, because the first draft of them was wrong in a way worth
remembering, and because they do not all carry the same weight. They are grouped by strength
— proven, solid, weak, anecdotal — so the weight of each is plain.

**Mechanism — proven.** Three concurrent callers at the same findings list produced one parse
execution and one continuation LLM call; two were skipped on each. A live run against the
loadable extension, on a host exposing the side-turn primitive, showed the same collapse with
real provider metering: two concurrent sub-agents at one state produced one new execution, one
recorded skip, and a usage delta for the owner with zero for the follower. The forest counts
are checkable by hand from the grammar — the naive nested list yields 2^(n−1), the structured
one exactly 2^k — so this tier is not a claim to take on faith.

The key discriminates, not just converges. The two real scenarios — nineteen findings against
eighteen — produce different segment keys and do not collide, so the key names the *reasoning*,
not merely the shared schema. And the retention claim from the preconditions is measured, not
asserted: with in-flight-only retention, two *sequential* callers run the work twice; with a
time-to-live policy, the second caller skips it entirely.

**Convergence — solid, but narrow.** The convergence pilot ran four independent sub-agents,
two against a loose prose schema and two against a tight deterministic one, extracting
findings from a single SQLAlchemy issue. The loose pair diverged on exactly two judgments — a
method-name's qualification, and whether an accessor counts — and produced different keys, so
no dedup. The tight pair, atomizing dotted names and holding a fixed order, returned identical
nineteen-token lists, byte-for-byte. Solid, but it is two pairs on one issue; the effect is
real and the breadth is not yet shown.

**Authoring — solid on the bound, weak on the meaning.** Five runs, one model family, one
host. In the first, the model was told to "mark the temporal kind" — a hint that names the
answer — and it wrote the naive nested-list grammar, saw 262,144 readings, diagnosed "pure
regrouping," and produced the `temporal | generic` grammar that landed on exactly 32, 2^5.
The other four runs were *unaided*: same finding-shape, same naive start, no hint. All four
bounded the explosion — two reached a single deterministic parse, two reached 32 readings by
picking out the all-caps tokens (DATETIME, DATETIME2, etc.), which happen to be the temporal
ones. So the durable claim is the first half: *on 5 of 5 runs the model took the exponential
grammar to a bounded one on its own.* The stronger claim — that it finds the *semantically
right* distinction — held only when the prompt named it, and by accident of spelling in two of
four unaided runs. That split is recorded in the limits as the authoring result's real
dependence.

Re-run live inside the fused loop, the authoring reproduces its numbers end to end: the naive
grammar reports 262,144 readings, the model is handed the hint, and the grammar it writes back —
`temporal | marker`, accepted by Marpa and advancing the version — reparses the same nineteen
findings to exactly 32. The re-run sharpens *which part* of the hint carries the weight: told only
to mark the temporal kind, a capable model keeps the naive grammar's nested list and lands at 512,
not 32; it reaches the bounded form only when it is also told to flatten the finding into a single
typed alternative. It is the regrouping, not the type distinction, that the model does not undo on
its own. Authoring works, and it is hint-dependent in a specific, nameable place — the move from "a
list of items" to "one typed finding."

**Cost — the weakest number, stated carefully.** The 16.5k figure in the summary —
"worth roughly sixteen-and-a-half thousand prompt tokens once cached context is counted" —
counts *cached* context: 521 uncached input tokens and 794 output, riding on about 16,640
cached-context tokens the model did not re-read. That is not a fresh-token cost, and missing
it overrates the saving. As a single data point from a single run it should
be quoted as "one subagent continuation carried a ~16.7k-token prompt (521 uncached)," not as
a general cost of the mechanism. The 600-token early guess was our own mistake, and the next
section says so.

One cost the ledger now tracks but had not: *authoring the grammar*. The grammar the loop
reworks is not inherited — the model writes and rewrites the SLIF source itself, and that
source is LLM output. Both surfaces now measure it (`grammar_author_tokens` on `reason`
`create`/`extend`, and `grammarAuthorTokens` on a non-shipped `grammar` argument; a single
chars/4 estimate), so a run's net saving is `skipped continuations − authoring spend`, and the
authoring setup must be amortized across followers before the mechanism is a net win. The
shipped finding grammars cost zero on that ledger; only a grammar the model actually authors
is charged.

**Collision rate — anecdotal, from two reference-extraction runs.** These are a different
four agents from the convergence pilot, given a literature-retrieval task instead of a
bug-finding one. In the schema-shared run, four extractors made twenty-five reference-requests
that collapsed to thirteen distinct citations, twelve absorbed — a duplicate fraction of
twelve of twenty-five, 0.48 — with a four-work core (Marpa, Earley, Aycock–Horspool, and the
Rathbun paper) found by everyone and the divergence confined to how far to extend the list.
In the schema-free run, one of four agents derailed and returned nothing usable; the other
three produced twenty-six line-items that normalize down to twenty-four mechanically-distinct
strings — a mechanical collision of 0.08 — even though a reader recognizes twelve distinct
works, eight of them found by two or more agents (a conceptual rate of eight of twelve,
0.67). The 0.08-to-0.67 gap measures how much *normalization* would help inside the
schema-free run. The schema's own effect is the contrast between the two runs — a 0.48
duplicate fraction under a shared schema against 0.08 without one — and even that is
confounded, since the two runs used different prompts. All of it is a handful of agents on
one corpus: a statement about the conditions under which the mechanism fires, not a rate for
any swarm.

A first *prevalence* probe at a third abstraction: six independent agents were each asked to
list every quantitative claim in this paper under a shared token schema. They produced 142
line-items in all, but only twenty-seven distinct values, and only three of those — the 262,144
naive reading, the 32 structured reading, and the 19 findings — were found by every agent;
four of six never agreed on more than a couple of the remaining numbers, and their list lengths
ran from thirteen to forty-five. The shape is the same as everywhere else in this section: a
small shared core everyone hits, and a long tail of scope disagreement no schema fully pins
down. It is, again, one corpus and six agents — but it is the first evidence that the "shared
core, divergent boundary" pattern is a property of the extraction task itself, not of the two
bug-finding and literature cases alone.

A *cross-task* check confirms the assumption the paper rests on, rather than testing the
mechanism: six agents, each on a different real SQLAlchemy issue, extracting finding-symbols
under one shared grammar with no schema beyond the symbol convention. Five produced usable
lists (one derailed into re-reading the live issue); together they named eighty-three symbols,
sixty-five of them distinct, and only *three* — column, metadata, table — appeared in three or
more lists, none in four, and fifty-one in exactly one. That near-empty intersection is why
the paper's scope is *shared work*, not all work: different tasks on the same codebase mostly
do not share, so there was never a saving to be had between them. The question the mechanism
leaves open is not "do different tasks share?" — they do not, and that is taken as settled —
but "when a broad ask splits one piece of reasoning across many agents, how much of it is the
*same* piece repeated?" The three-condition answer to that is the "when does this fire?"
section, and the rate at which real shared asks repeat the same piece is the one prevalence
number still worth measuring.

**Long-horizon sharing — live, one subsystem.** Everything above is a single turn: an agent
extracts a finding list once, under a frozen schema, and we ask whether two agents matched. That is
the wrong regime for the claim the mechanism actually makes, which is that convergence accumulates
over many turns as code-grounded agents re-engage the same component — the schema is grown, not
written once, and only where a problem reaches for it. To see the horizon we ran three agents over
a real code task — each implementing overlapping fixes in the SQLAlchemy SQL Server reflection
subsystem (identity seed, precision, temporary-table collation, a reflection hang) across a genuine
edit loop, with the segment coordinator wired into their loop so that each engaged symbol was
emitted through it as the agent worked. Over 153 turns the three agents touched 52 distinct code
symbols, *half* — 26 — engaged by at least two agents, a core that accumulated rather than appearing
at once (one shared symbol by the first turn, 25 by the thirtieth). The coordinator, running a real
model, executed 83 of 118 continuations and skipped 35 — a 30-percent collision, observed to climb
from 0 percent in the opening turns to 30 percent by the end — the 26-symbol core being the
*sub-segment* shape the shapes section names: the same component re-appearing inside flows that
otherwise differ. (An offline reconstruction of the first run's recorded trail had estimated 36
percent; the live number sits in the same band, now observed rather than computed.) Priced at the
fresh per-continuation cost — the only honest one, per the cost section — the 35 skips are about
46,000 tokens avoided for three agents on one subsystem. One subsystem and three agents is a point,
not a curve; but it is a first point that runs from repeated reasoning to a live token count, and it
locates the benefit in the length of the task rather than the tightness of a one-shot schema.

## WHAT WE HAVE NOT DONE

Six limits are worth naming, because a mechanism proven once is not yet a claim that a
swarm collides often.

The first is the *rate at which shared work repeats* — the number a deployment actually needs,
and the one the rest of this paper deliberately stops short of. Everything above is a handful
of agents — four, then six, then six more on six different SQLAlchemy issues — on a few
corpora, with a schema either imposed or withheld deliberately. The cross-task probe settled
the easy part: different tasks do not share, and that is out of scope, not a gap. What remains
unmeasured is the harder part — how often a broad shared ask, the same codebase read and
re-read by many agents, repeats the same piece of reasoning — because that is where the saving
actually lives.

That missing number has a name worth giving it: the *segment allowance*, the fraction of a
swarm's segments that would be repeats. Two complementary routes measure it, and both are cheap
because the key is already computed for free. The first is empirical: log every segment key a
real run produces and count — total segments, distinct segments, and how many appear twice,
three times, k times — turning the collision rate into a measured histogram. The second is
analytic: the measured shape so far is a small shared core everyone hits plus a long tail of
divergence, the signature of a heavy-tailed distribution over segments, and under that model
the expected repeat count is a closed form in the tail exponent and the swarm size — a
prediction of the dedup fraction *before* the swarm is paid to run. Three candidate workloads
would stress the model three ways: a parallel sweep of a real issue list (SQLAlchemy), a shared
generative task whose segments are prose that must stay consistent (a choose-your-own-adventure
tree), and a repeat-heavy harness where agents re-run the same UI interactions. Each is
specified in the companion measurement plan. And one number now exists in place: the
long-horizon run reported above — three agents, one subsystem, 153 turns — is a ~30-percent live
collision (35 of 118 continuations deduplicated), observed climbing over the run rather than
reconstructed. A point, not yet a curve.

The second is the *cross-process* boundary. Every result here is in-flight within one process;
the distributed form (a Redis-backed coordinator, already ported) has not been exercised, and
the CAP-sensitivity the earlier paper discusses has not been revisited under it.

The third is the *loop surface*. Today the dedup fires when two agents happen to reach the same
state concurrently; actually suppressing the agent's own next provider call — rather than
collapsing a coordinated side turn — requires a single hook the host does not yet expose.
Until it exists the saving is on shared side-work, not on the agent's primary reasoning. It
counts as the single most useful thing to build next.

The fourth is *breadth of shape*. The results span one extraction shape (symbol lists), one
grammar (the temporal/marker distinction), and two real issues. That is a demonstration, not
a survey; whether the claim generalizes to other finding-shapes is open.

The fifth is the *authoring result's dependence*. Five runs, one model family, one host. On
all five the model bounded an exponential grammar on its own, but it reached the semantically
right temporal/generic distinction only when the prompt named it — or by the accident that the
temporal tokens are the all-caps ones. One family, one host, one finding-shape: the authoring
claim is scoped to exactly that.

The sixth is the *hint in the prompt*. The strongest trace — "mark the temporal kind, see
262,144, refactor to temporal versus generic, see 32" — was aided by a prompt that told the
model what to look for; the live re-run shows the load is carried by the *structural* half, the
instruction to flatten a nested list of items into one typed finding, not merely by naming the
temporal kind. It is a real trace of the loop running; it is not evidence that the model
discovers the distinction unprompted.

## CONCLUSION

The promise pattern already told us that any work that can be uniquely named can be made to
run once. The difficulty with agents was never the coordination; it was that a thought has no
name until someone gives it one. This work gives it one: parse the finding, hash the structure,
and let the ambiguity be the signal rather than the error. What falls out is a small loop —
the model writes the grammar, parses, notices the undecided, holds, refines, reparses — that
turns the agent's own indecision into a shareable unit of work, and a coordinator that runs
each such unit once. The grammar is no one's burden; it is the first thing the model
produces, and the thing it keeps improving.

The claim is stated at its true size. With real provider metering, identical concurrent work
collapses to one execution — in our run, a single subagent continuation carried a roughly
16.7k-token prompt, counted cache-inclusive. The parser's ambiguity count is structured and
meaningful when the grammar is, and exponential noise when it is not, and the model is the
one who rewrites the noisy grammar into the bounded one — in every run recorded here — though
which bound it lands on depends on what the prompt tells it to look for. The two loops have now
run fused and live in one system rather than as separate tiers: the authoring loop — naive
grammar, 262,144 readings, the model's `temporal | marker` back down to 32 — feeding the
coordinator that deduplicated 35 of 118 continuations keyed on that grammar. The authoring carries
the one name-specific dependence described above; the coordination does not. What is measured and
what is not stays separate: the mechanism is proven, and one real multi-turn task now gives a
first live point on the rate at which shared work repeats — a 30-percent collision climbing over
153 turns, observed as the coordinator ran — while turning that point into a distribution for a
real swarm is still open. Finding that
rate is exactly the kind of work — nameable, shareable, worth doing once — that the system
described here was built to make cheap.

---

## REFERENCES

1. Rathbun, Spencer. *Parallel Processing with Promises.* ACM Queue, 2014.
   — the prior algorithm this paper builds on; the "work that can be uniquely named runs once" thesis.

2. Earley, Jay. "An Efficient Context-Free Parsing Algorithm." *Communications of the ACM* 13(2):94–102, 1970.
   — the recognizer family Marpa generalizes; the source of the generalized-parsing line.

3. Kegler, Jeffrey. *Marpa: A Practical General Parser: The Recognizer.* arXiv:1910.08129.
   Also the *Ruby Slippers* essays (https://jeffreykegler.github.io/marpa-article.html).
   — the generalized parser used here; the source of ambiguity-as-data and of the Ruby Slippers
   on-the-fly grammar-rewriting technique the hold-and-refine loop borrows.

4. Aycock, John; Horspool, R. Nigel. "Practical Earley Parsing." *The Computer Journal* 45(6):620–630, 2002.

5. Scott, Elizabeth; Johnstone, Adrian. "GLL Parsing." *Electronic Notes in Theoretical Computer
   Science* 253:177–189, 2010.
   — another generalized-parsing line, cited for completeness on the grammar-algorithm side.

6. Ford, Bryan. "Packrat Parsing: Simple, Powerful, Lazy, Linear Time." *ICFP 2002*, pp. 227–240.
   — the memoized-parsing line; relevant to the "parse once, reuse" theme.

7. Tomita, Masaru. *Efficient Parsing for Natural Language: A Fast Algorithm for Practical Systems.*
   Kluwer Academic Publishers, 1986.
   — the GLR tradition, a third generalized-parsing family.

8. Lang, Bernard. "Deterministic Techniques for Efficient Non-Deterministic Parsers." 1974.
   — the GLR algorithm's lineage alongside Tomita.

9. *Go singleflight* — `golang.org/x/sync/singleflight`. https://github.com/golang/sync
   — the in-process single-flight pattern in a widely deployed systems library; independent of,
   but convergent with, the promise-keyed design.

10. Zheng, Lianmin; Yin, Liangsheng; Xie, Zhiqiang; et al. "SGLang: Efficient Execution of
    Structured Language Model Programs." arXiv:2312.07104, 2023.
    — RadixAttention, the radix-tree KV cache that reuses shared prefixes across identical
    agent prompts; the inference-layer dedup this paper's segment dedup complements.

11. Packer, Charles; Wooders, Sarah; Lin, Kevin; et al. "MemGPT: Towards LLMs as Operating
    Systems." arXiv:2310.08560, 2023.
    — hierarchical virtual memory with tool-result caching; the "memoize across sessions" line
    closest to, but distinct from, the parse-keyed dedup described here.

12. Xie, Zhiqiang, et al. "SGLang HiCache: Fast Hierarchical KV Caching with Your Favorite
    Storage Backends." LMSYS blog, 2025. https://lmsys.org/blog/2025-09-10-sglang-hicache/
    — engineering report; extends KV reuse across storage tiers, the current frontier of
    prefix-caching scale. (Technical report, not peer-reviewed.)

13. Huang, Zhangheng; Bao, Ke; Zhang, Yi; et al. "Unified Radix Cache: One Tree for Hybrid
    Model Prefix Caching." LMSYS blog, 2026.
    https://www.lmsys.org/blog/2026-08-11-unified-radix-cache/
    — a single radix topology unifying reuse semantics; cited to anchor the claim that
    prefix-caching is the dominant adjacent technique. (Technical report, not peer-reviewed.)

14. "vCache: Verified Semantic Prompt Caching." arXiv:2502.03771, ICLR 2026.
    — semantic caching with correctness guarantees around the similarity decision; the
    probabilistic contract this paper contrasts with its lossless declared-identity contract.

15. "KVFlow: Efficient Prefix Caching for Accelerating LLM-Based Multi-Agent Workflows."
    arXiv:2507.07400, NeurIPS 2025.
    — workflow-aware prefix reuse across agents; the other, complementary direction of
    multi-agent redundancy work.

16. "KVCOMM: Online Cross-context KV-cache Communication for Efficient LLM-based Multi-agent
    Systems." arXiv:2510.12872, NeurIPS 2025.
    — cross-context KV reuse between agents; anchors the claim that context-level reuse is the
    currently dominant adjacent approach.