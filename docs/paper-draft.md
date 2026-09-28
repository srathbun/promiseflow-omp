# The Work Already Done: Parsing and Promises for Collaborative Agents

### Spencer Rathbun (with the Aristotle × PromiseFlow collaboration)

> DRAFT — working document for collating the paper. Citation facts still require a live
> search window; unresolved fields are marked `[verify]`.

## PROBLEM AND CONTRIBUTION

Multi-agent coding and research teams waste the same reasoning on the same material — two
agents reading one failing trace, four agents re-deriving one assumption — each paying for a
model call that another agent has already made, at twenty thousand to one hundred and sixty
thousand tokens per turn. This paper gives those teams a mechanism they can build and keep
using: name a unit of reasoning *before* it runs, so concurrent agents doing the same unit
run it once. It reports, in numbers rather than promises, when that mechanism actually fires, and it
says straight what it does not yet do: suppress the agent's own primary model call. In
short: the problem is repeated reasoning; the cost is repeated model calls; the remedy is a
name for reasoning, built by a parser; and the saving, today, is on shared side-work, not on
the agent's own call.

---

When a team of agents is asked to build one thing together, the most expensive thing they
do is not the work itself. It is the work twice.

Two agents reading the same failing trace both resolve the same symbol names. Four agents
checking the same assumption each re-derive it from scratch. Nothing in the system notices,
because the second agent has no way to know the first already began — let alone finished —
the identical thought. The results are paid for, token by token, once per agent. This paper
describes a small, self-contained idea that removes that waste: *parse the work before it is
run, so that identical work can be named, and named work can be run once.*

The idea leans on two existing tools, neither of which we invented. The first is a
generalized parser, a program that reads a grammar and reports not merely whether text
conforms, but *every* way it could conform. The second is a single-flight coordination
pattern built on promises, the subject of an earlier paper (Rathbun, *Parallel Processing
with Promises*), which guarantees that work bearing the same name executes once even when
many workers demand it at once. The contribution of this paper is the bridge between them:
a name for *reasoning*, computed deterministically from a parse, before the expensive step
begins. What we are about to tell you is that this bridge holds — under measurement, and
against real agents' stubborn habit of disagreeing on how to say the same thing.

## WHAT WE WILL TELL YOU

We proceed in the order a reader would naturally need it. First the problem and what,
exactly, the promise pattern already buys us. Then the closest and best-known alternative —
prefix caching — and why it does not reach the thing we care about. Then the difficulty: a
thought has no ready-made name, so we must give it one. We show how parsing supplies that
name, and why a *generalized* parser matters — because ambiguity, which an ordinary parser
rejects as an error, is exactly the signal we need. We then walk one complete loop — the
model writes a grammar for what it wants to find, parses, notices where the grammar leaves
the matter undecided, holds the turn, and revises the grammar before reparsing. Say it early, because it is what makes all of this practical:
*the model writes the grammar.* Nobody adopting this system is handed a parsing problem to
solve first. With the pieces in hand we lay out the system itself, say when it fires and when it
will not, and report the measured evidence in tiers — from the proven, through the solid, to
the anecdotal — so the weight of each claim is plain. We close with the limits.

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
take over the work. The point is not that promises are novel — they are not — but that they
reduce the whole coordination problem to two states a programmer can hold at once: *working*
and *waiting*.

That reduction only works, however, when the work has a name the parties can agree on. The
database query names itself by hashing its text. The build artifact names itself by its
inputs. For this kind of work, "the same name" is settled by an agreed convention, and the
coordination is nearly free. The question that motivates everything that follows is: *what is
the name of a thought?* Why not just cache the model's context, then? That question gets its
answer in the next section, and then we come back to naming.

## WHERE THIS SITS

Why is this not simply prefix caching? The systems that do that are real and shipping, and
the answer marks where this paper stops and they begin. Systems such as SGLang's
RadixAttention and MemGPT's virtual memory already make repeated *model calls*
cheap: when two agents send the same prompt, the shared prefix — the re-sent system context,
which is precisely the dominant cost our measurements expose — is computed once and reused.
That work is real and shipping. What it does not remove is the *decision itself*. Two agents
whose contexts are identical still run the same continuation twice; a KV cache saves the
prefix, not the thought.

This paper works the other axis. The thing deduplicated here is the *segment* —
the grammar-shaped finding the agent has produced — so the continuation that follows it runs
once rather than once per agent. The two ideas compose rather than compete: prefix caching
makes each single flight cheap, and segment deduplication removes the redundant flights.
One is about the material a model call is made of; the other is about whether the call is
made at all. The distinction matters because the expensive part of an agent's work is not the
context it carries but the conclusion it draws, and until the conclusion has a name, no cache
can prevent drawing it twice.

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

Ambiguity, then, is not noise. It is the parser telling us how much of the agent's finding
remains undecided, and that number is load-bearing. Our measurements show it takes two very
different shapes, and the distinction governs the entire design.

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
that motivated this work it is exactly the distinction a maintainer needed to diagnose it. Good ambiguity is structured, bounded, and meaningful; bad ambiguity is partition
noise. And this is the part that makes the whole thing practical: *nobody but the model writes
either kind.*
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

We watched this happen end to end on the finding-shape above. Given the nineteen SQLAlchemy
symbols and the instruction to mark the temporal kind, a model wrote a naive grammar — a
document of findings, each an unconstrained list of items — and the parser answered with
262,144 readings. The model read that count, named the failure (pure regrouping, no
information), and rewrote the grammar to split each item into a temporal literal or a generic
identifier. The same nineteen tokens parsed to exactly 32 readings, 2^5 — one binary choice
per genuinely-undecided temporal point. The refinement did not just shrink the number; it
made the number *mean* something. The count is reproduced verbatim in the evidence.

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

The extension exposes two tools. *parse_segment* runs the Marpa parse behind the coordinator
and returns the forest; it is pure compute, and its dedup saves cycles, not tokens. *
reason_segment* runs the LLM continuation behind the same coordinator, keyed by parse state
under a distinct scheme; its dedup is where the token budget is actually spent less. They are
deliberately separate — a parse and a continuation at the same grammar and fragments are
different work with different costs, and were they to share a key they would wrongly collide.

Two design points matter because they are the ones that failed in naive form and succeeded
in this form. The first is the *process-wide* coordinator: it must live once per
process, shared by every sub-agent, or the guarantee evaporates the moment the work splits
across agents. The second is *namespacing*, already stated. The third, said once and clearly:
the coordinator's default is *in-flight only* — it deduplicates callers who
overlap in time, and a later, sequential caller recomputes — unless a retention policy is
chosen, a one-line change whose effect we measured and report in the evidence.

## WHEN DOES THIS FIRE?

A mechanism that works when forced is only useful if we can say when it fires on its own.
Three conditions fell out of the measurements, and they say what the forced demo predicts.

First, *the agents must share a deterministic extraction schema.* This is the load-bearing
one, and it is the one the prose cannot carry: without an agreed canonical form, two agents
arriving at the same finding produce different bytes, and different bytes mean different keys
— no dedup. The schema is the thing the grammar formalizes.

Second, *the agents must overlap in time, or a retention policy must bridge the gap.* With
in-flight-only retention, a caller arriving after the owner has finished recomputes; with a
time-to-live retention, a later caller within the window skips the work entirely. Which one
applies is a deployment choice, not a property of the idea.

Third, *the extraction must be coarse enough that independent agents land on the same core.*
Measured without any shared schema, agents converged conceptually on four load-bearing works
out of twelve — but named them differently, so the mechanical collision rate is far lower
than the conceptual one. The saving lives at the boundary where the schema pins the core down.

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

**Convergence — solid, but narrow.** Four independent sub-agents, two against a loose prose
schema and two against a tight deterministic one. The loose pair diverged on exactly two
judgments — a method-name's qualification, and whether an accessor counts — and produced
different keys, so no dedup. The tight pair, atomizing dotted names and holding a fixed order,
returned identical nineteen-token lists, byte-for-byte. Solid, but it is two pairs on one
issue; the effect is real and the breadth is not yet shown.

**Cost — the weakest number, stated carefully.** The 16.5k figure in the summary —
"worth roughly sixteen-and-a-half thousand prompt tokens once cached context is counted" —
counts *cached* context: 521 uncached input tokens and 794 output, riding on about 16,640
cached-context tokens the model did not re-read. That is not a fresh-token cost, and missing
it overrates the saving. As a single data point from a single run it should
be quoted as "one subagent continuation carried a ~16.7k-token prompt (521 uncached)," not as
a general cost of the mechanism. The 600-token early guess was our own mistake, and the next
section says so.

**Collision rate — anecdotal, and now a two-sided one.** With a shared deterministic schema,
four extractors made twenty-five reference-requests, thirteen distinct, twelve absorbed — a
duplicate fraction of 0.48, with the four load-bearing works found by everyone and the
divergence confined to how far to extend the list. Without a shared schema, the same four
agents diverged far more: twenty-six line-items became twenty-four mechanically-distinct
strings (a mechanical collision rate of 0.08), even though a reader recognizes twelve works
with the same four at the core (a conceptual rate of 0.67). The gap between 0.08 and 0.67 *is*
the schema's contribution, measured. It is still four agents on one corpus; that is the
anecdote, and it is a statement about the conditions under which the mechanism fires, not a
claim about how often any swarm collides.

## WHAT WE HAVE NOT DONE

Four limits are worth naming, because a mechanism proven once is not yet a claim that a
swarm collides often.

The first is the *collision rate at scale*. Everything above is four agents, one corpus, with
a schema either imposed or withheld deliberately. A real rate — across a live, multi-agent
workload with genuinely independent tasks — remains unmeasured, and it is the one number this
work has only begun to find.

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
meaningful when the grammar is, and exponential noise when it is not, and a model, not an
engineer, turns the one into the other. What is measured and what is not stays separate: the
mechanism is proven, while the rate at which a real swarm collides is still open. Finding that
rate is exactly the kind of work — nameable, shareable, worth doing once — that the system
described here was built to make cheap.

---

## REFERENCES

> Citation status: web search is currently down (all providers returning 503/blocked), so
> entries are drawn from established bibliographic records rather than freshly fetched pages.
> Fields the author cannot assert with confidence are marked `[verify]` — especially the
> volume/issue/DOI of the Rathbun paper, which the author should confirm against the archive.
> No DOI has been invented; where one appears it is from memory and flagged until it is fetched.

1. Rathbun, Spencer. *Parallel Processing with Promises.* ACM Queue. `[verify volume/issue]`
   (PDF footer reads "© 2015 ACM 1542-7730/14/0200", i.e. the Feb 2014 issue; confirm exact volume).
   — the prior algorithm this paper builds on; the "work that can be uniquely named runs once" thesis.

2. Earley, Jay. "An Efficient Context-Free Parsing Algorithm." *Communications of the ACM* 13(2):94–102, 1970.
   — the recognizer family Marpa generalizes; the source of the generalized-parsing line.

3. Kegler, Jeffrey. *Marpa: A Practical General Parser* — the article series, particularly
   *The Recognizer* and *The Evaluator*, and the *Ruby Slippers* essays. 2012–2014.
   https://jeffreykegler.github.io/marpa-article.html `[verify individual article years]`
   — the generalized parser used here; the source of ambiguity-as-data and of the Ruby Slippers
   on-the-fly grammar-rewriting technique the hold-and-refine loop borrows.

4. Aycock, John; Horspool, R. Nigel. "Practical Earley Parsing." *The Computer Journal* 45(6):620–630, 2002.

5. Scott, Elizabeth; Johnstone, Adrian. "GLL Parsing." *Electronic Notes in Theoretical Computer
   Science* 253:177–189, 2010. `[verify issue number]`
   — another generalized-parsing line, cited for completeness on the grammar-algorithm side.

6. Ford, Bryan. "Packrat Parsing: Simple, Powerful, Lazy, Linear Time." *ICFP 2002*, pp. 227–240.
   — the memoized-parsing line; relevant to the "parse once, reuse" theme.

7. Tomita, Masaru. *Efficient Parsing for Natural Language: A Fast Algorithm for Practical Systems.*
   Kluwer Academic Publishers, 1986.
   — the GLR tradition, a third generalized-parsing family.

8. Lang, Bernard. "Deterministic Techniques for Efficient Non-Deterministic Parsers." 1974.
   `[verify venue/pages]` — the GLR algorithm's lineage alongside Tomita.

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

<!-- Primary sources (1–9) and adjacent-technique pointers (10–13) in place; DOIs/volumes
     for 1, 3, 8 remain `[verify]` pending a live search provider. -->