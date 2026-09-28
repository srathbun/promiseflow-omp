# The Work Already Done: Parsing and Promises for Collaborative Agents

### Spencer Rathbun (with the Aristotle × PromiseFlow collaboration)

> DRAFT — working document for collating the paper. Structure, thesis, conclusion, and
> references follow; body sections are in the author's voice. Citation facts still being
> verified by three parallel research agents; unresolved fields are marked `[verify]`.

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
under the messiness of real agents disagreeing about the same source material.

## WHAT WE WILL TELL YOU

We proceed in the order a reader would naturally need it. First we recall why identical work
is a danger and what the promise pattern already buys us — the reader of the earlier paper
will recognize the passage. Then we meet the difficulty: a thought has no ready-made name,
so we must give it one. We show how parsing supplies that name, and why a *generalized*
parser matters — because ambiguity, which an ordinary parser rejects as an error, is exactly
the signal we need. We then walk one complete loop: parse, notice ambiguity, hold the turn,
refine the grammar, reparse. With the pieces in hand we assemble the working system and
report the numbers, both the comfortable ones and the ones that surprised us. We close with
the honest limits, because a mechanism that works once is not yet a claim that a swarm of
agents always collides.

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
and every follower retries together. The point is not that promises are novel — they are
not — but that they reduce the whole coordination problem to two states a programmer can
hold at once: *working* and *waiting*.

That reduction only works, however, when the work has a name the parties can agree on. The
database query names itself by hashing its text. The build artifact names itself by its
inputs. For this kind of work, "the same name" is settled by an agreed convention, and the
coordination is nearly free. The question that motivates everything that follows is: *what is
the name of a thought?*

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

This is the first real finding of the work, and it deserves stating plainly: *whether two
agents collide is not a property of their prompt, but of their schema.* Give the agents a
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
produced it. For a reader new to the terms, think of the grammar as the form, the parse as
the fill-in, and the *parse forest* as every fill-in that fits.

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
The distinction between "temporal-type" and "generic-mention" is not an ornament; it is, in
the real bug that motivated this work, precisely the distinction a maintainer needed to
diagnose it. Good ambiguity is structured, bounded, and meaningful; bad ambiguity is partition
noise. The engineer's task is to write grammars of the first kind, and the parser's reward for
doing so is a forest small enough to act on.

## THE HOLD-AND-REFINE LOOP

Because ambiguity is reported rather than rejected, it can drive a loop in the agent's own
turn. When a parse comes back ambiguous, the loop is this: notice the undecided points, hold
the turn before the next expensive step, extend the grammar with the rule that would settle
them, and reparse. This borrows an idea Kegler named the Ruby Slippers technique — the parser
can revise its own grammar in response to what it finds — applied here not to rescue a failed
parse but to *defer a decision and then make it explicit.*

The loop is a work unit like any other, which means it itself has a name and can itself be
deduplicated. Two agents arriving simultaneously at the same ambiguous state do not each run
the refine-and-reparse dance; one runs it, the other awaits the shared result. The observation
that matters for the architecture is that this whole loop is expressible as a *stateless* work
factory — parse, then on ambiguity extend, then reparse — with no lingering state, so a holder
of the turn can offer it to a shared coordinator without worrying whose grammar is whose.

## PUTTING THE PIECES TOGETHER

We can now state the system in one breath, the way it actually runs. A completed agent turn
is parsed by the extension; the ordered fragments and the grammar that shaped them are hashed
together into a *segment key*, computed before any model call the segment would trigger; the
key is handed to a single-flight coordinator; the first claimant becomes the owner and runs
the work — parse, or continuation, or refine-loop — while every concurrent claimant at the
same key becomes a follower who awaits the one result. The coordination is the promise pattern
from the earlier paper, wired to a key that names *reasoning* rather than a database query.

Two design points deserve emphasis because they are the ones that failed in naive form and
succeeded in this form. The first is the *process-wide* coordinator: it must live once per
process, shared by every sub-agent, or the guarantee evaporates the moment the work splits
across agents. The second is *namespacing*. A parse and an LLM continuation at the same
grammar and fragments are different work with different costs — one spends compute, the other
spends tokens — and if they shared a key they would collide. They carry distinct schemes.

The empirical outcome, for a real query: three concurrent callers at the same findings list
produced one parse execution (two skipped) and one continuation LLM call (two skipped). The
parse savings are compute-only — every caller still emits its arguments and reads the result.
The token savings are the continuation's alone, and they are the ones that justify the
machinery: a skipped continuation is a skipped model call, and a model call, measured on the
real system, is worth far more than the small number the early estimates suggested.

## WHAT WE MEASURED

The measurement deserves its own honesty section, because the first draft of these numbers
was wrong in a way that teaches something.

**Convergence is a schema property.** Four independent sub-agents, two against a loose prose
schema and two against a tight deterministic one. The loose pair diverged on exactly two
judgments — whether a method name is qualified with its class, and whether an accessor counts
as a finding — and thus produced different keys and could not deduplicate. The tight pair,
atomizing dotted names and holding a fixed order, returned identical nineteen-token lists,
byte-for-byte, and deduplicated.

**Amplification is real and must be tamed.** An unstructured grammar turned a nineteen-finding
list into 262,144 interpretations before the structured grammar reduced the same material to
32. The exponential is not a curiosity to be averaged away; it is what happens when ambiguity
is counted without being structured, and it is why the grammar author's job, not the prompt
writer's, is the decisive one.

**The token scale was understated, and the mechanism was not.** Early estimates pegged a
skipped continuation at roughly six hundred tokens. The real provider metering in the session
transcripts shows a single agent turn costs on the order of twenty to one-hundred-sixty
thousand tokens — the re-sent system context dominates — and a deduplicated continuation is
worth roughly sixteen-and-a-half thousand prompt tokens once cached context is counted. The
*skip count* was always exact (two requests, one execution); only the *price* of a skip grew
by two orders of magnitude once measured instead of guessed.

**The loop is live, not simulated.** A second run against the loadable extension, on a host new
enough to expose the side-turn primitive, showed two concurrent sub-agents at the same state
produce one new execution, one recorded skip, and a real provider usage delta for the owner
with zero for the follower. The earlier "no LLM primitive in this host" dead-end was not a flaw
in the idea but a version mismatch, and it resolved when the host grew the primitive.

**A first collision rate, measured rather than asserted.** To answer the open question — how
often do independent agents coincidentally name the same work — four agents were each asked,
from the same source documents and under the same output schema, to extract the references this
work depends on. Together they made twenty-five reference-requests, of which thirteen were
distinct; four of the thirteen were found by more than one agent, and three of the four agents
converged on an identical four-item core (the Earley, Kegler, Aycock–Horspool, and Rathbun works)
before diverging only on how far to extend the list. Single-flight coordination over the
twenty-five requests produced thirteen executions and absorbed twelve as followers — a
duplicate-request fraction just under one half. This is one small, four-agent, single-corpus run
under a deterministic schema, and it is not yet a rate worth quoting as the field's number. It
is, however, the first measured collision from *unprompted* independent agents rather than a
forced one, and it lands where the design predicted: the agents collided on the shared core and
diverged at the scope boundary — same finding, different list.

## WHERE THIS SITS

A reader familiar with inference systems will ask why this is not simply prefix caching.
It is a fair question, and the answer marks the boundary of the contribution. Systems such
as SGLang's RadixAttention and MemGPT's virtual memory already make repeated *model calls*
cheap: when two agents send the same prompt, the shared prefix — the re-sent system context,
which is precisely the dominant cost the measurements expose — is computed once and reused.
That work is real and shipping. What it does not remove is the *decision itself*. Two agents
whose contexts are identical still run the same continuation twice; a KV cache saves the
prefix, not the thought.

This paper addresses the complementary axis. The thing deduplicated here is the *segment* —
the grammar-shaped finding the agent has produced — so the continuation that follows it runs
once rather than once per agent. The two ideas compose rather than compete: prefix caching
makes each single flight cheap, and segment deduplication removes the redundant flights.
One is about the material a model call is made of; the other is about whether the call is
made at all. The distinction matters because the expensive part of an agent's work is not the
context it carries but the conclusion it draws, and until the conclusion has a name, no cache
can prevent drawing it twice.

## WHAT WE HAVE NOT DONE

Three limits should be printed clearly, because a mechanism proven once is not yet a claim
that a swarm collides often.

The first is the *collision rate*. The mechanism was proven on forced collisions; the unprompted
rate sat unmeasured until a four-agent reference-extraction run reported a duplicate-request
fraction near one half, with divergence concentrated at the boundary of what to include rather
than in the shared core. That run is small, single-corpus, and schema-bound; a real rate — across
a live, multi-agent workload with genuinely independent tasks — remains the open measurement. It
is the one number this work has only begun to find.

The second is the *cross-process* boundary. Every result here is in-flight within one process;
the distributed form (a Redis-backed coordinator, already ported) has not been exercised, and
the CAP-sensitivity the earlier paper discusses has not been revisited under it.

The third is the *loop surface*. Today the dedup fires when two agents happen to reach the same
state concurrently; actually suppressing the agent's own next provider call — rather than
collapsing a coordinated side turn — requires a hook the host does not yet expose. It is a
small, well-understood addition, and until it exists the saving is on shared side-work, not on
the agent's primary reasoning. We count it as the single most valuable next contribution.

## CONCLUSION

The promise pattern already told us that any work that can be uniquely named can be made to
run once. The difficulty with agents was never the coordination; it was that a thought has no
name until someone gives it one. This work gives it one: parse the finding, hash the structure,
and let the ambiguity be the signal rather than the error. What falls out is a small loop —
parse, notice the undecided, hold, refine, reparse — that turns the agent's own indecision into
a shareable unit of work, and a coordinator that runs each such unit once.

The reader who started skeptical is owed the honest scale of the claim. We have shown, with
real provider metering, that identical concurrent work collapses to one execution and that the
collapsed unit is measured in the tens of thousands of tokens, not the hundreds. We have shown
that the parser's ambiguity count is structured and meaningful when the grammar is, and
exponential noise when it is not. And we have shown the one thing a systems paper owes most:
which part of the claim is a measured result and which part remains, for now, a well-marked
open question. The mechanism is proven. The rate at which a real swarm collides is the next
number to find, and finding it is exactly the kind of work — nameable, shareable, worth doing
once — that the system described here was built to make cheap.

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