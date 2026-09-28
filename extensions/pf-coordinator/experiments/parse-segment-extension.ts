// parse-segment-extension.ts — OMP extension exposing the coordinated parse as
// an LLM-callable tool. Load with:
//   omp --extension ./extensions/pf-coordinator/experiments/parse-segment-extension.ts
//
// The factory itself holds no per-session state; the shared Coordinator + worker
// live in `parse-segment.ts` at module scope, so every subagent that rebinds this
// extension dedupes through the same process-wide instance.
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_GRAMMAR, coordinatedReason, parseSegment, renderSegment } from "./parse-segment.ts";

const TOOL_DESCRIPTION = `Parse an ordered stream of "finding" fragments through a process-wide single-flight coordinator (Aristotle grammar + Marpa, coordinated by PromiseFlow).

This is not a cache: two agents that submit the SAME grammar and the SAME ordered fragments concurrently cause the parse to run ONCE, and both receive the same result (the second is a follower). Use it to turn your findings into a parseable record without paying for duplicate computation.

- fragments (string[]): your findings, one string per fragment, in DETERMINISTIC order (sort them — order is part of the identity). Separate words within a fragment with spaces.
- grammar (string, optional): SLIF grammar source. Omit it to use the shared default grammar, which is what makes cross-agent dedup fire.

The result reports the parse status, the number of interpretations (ambiguity), the segment identity, and the coordinator's owner/follower/execution counters (detect dedup at a glance).`;

const REASON_TOOL_DESCRIPTION = `Derive a next step or conclusion from an ordered finding-fragment set, coordinated by PromiseFlow. The LLM continuation is the segment: two agents at the SAME (grammar, fragments) state cause ONE LLM side-turn, and the follower receives the answer without spending the LLM turn (skipped tokens).

- fragments (string[]): your findings, one per string, deterministic order.
- question (string, optional): what to derive (defaults to root cause).
- grammar (string, optional): omit for the shared default grammar.

The result is the derivation text, plus the coordinator's LLM-call and skipped-call counters.`;

/**
 * Stub orchestrator prompt for the step-3 subagent run (not used by this
 * extension; a template for the caller that dispatches subagents).
 *
 * The two load-bearing requirements for dedup to fire:
 *   1. fragments must be DERIVED findings (extracted from code/issue text), not
 *      free prose;
 *   2. fragments must be emitted in a FIXED deterministic order (sort them), so
 *      two agents covering the same material produce the byte-identical prefix.
 */
export const SUBAGENT_PROMPT_TEMPLATE = `Investigate: {PROBLEM}.

As you work, record each concrete finding as a short token string and submit the
full ordered set via the parse_segment tool exactly once when done:
  - one finding per fragment, words separated by spaces;
  - put the fragments in a fixed deterministic order (e.g. lexicographic);
  - do not include prose or reasoning in the fragments.`;

export default function (pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.registerTool({
    name: "parse_segment",
    label: "Parse Segment (Aristotle + PromiseFlow)",
    description: TOOL_DESCRIPTION,
    parameters: z.object({
      fragments: z.array(z.string()).describe("Ordered finding fragments (deterministic order)"),
      grammar: z.string().optional().describe("SLIF grammar source; omit to use the shared default"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
      // `pi.zod` exposes an untyped Static, so `params` is `unknown` here even
      // though the schema validated it at the tool-call boundary (same shape as
      // pf-coordinator's wrapped tools). Recover the fields defensively.
      const p = (params ?? {}) as { fragments?: unknown; grammar?: unknown };
      const fragments = (Array.isArray(p.fragments) ? p.fragments : []).filter(
        (f): f is string => typeof f === "string",
      );
      if (fragments.length === 0) {
        return {
          content: [{ type: "text", text: "parse_segment: fragments must be non-empty" }],
          isError: true,
        };
      }
      const grammar = typeof p.grammar === "string" && p.grammar.length > 0 ? p.grammar : DEFAULT_GRAMMAR;
      const r = await parseSegment(grammar, fragments);
      return { content: [{ type: "text", text: renderSegment(r.key, r.parse, r.stats) }], details: r };
    },
  });

  pi.registerTool({
    name: "reason_segment",
    label: "Reason Segment (Aristotle + PromiseFlow)",
    description: REASON_TOOL_DESCRIPTION,
    parameters: z.object({
      fragments: z.array(z.string()).describe("Ordered finding fragments (deterministic order)"),
      grammar: z.string().optional().describe("SLIF grammar; omit for the shared default"),
      question: z.string().optional().describe("What to derive; defaults to root cause"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const p = (params ?? {}) as { fragments?: unknown; grammar?: unknown; question?: unknown };
      const fragments = (Array.isArray(p.fragments) ? p.fragments : []).filter(
        (f): f is string => typeof f === "string",
      );
      if (fragments.length === 0) {
        return { content: [{ type: "text", text: "reason_segment: fragments must be non-empty" }], isError: true };
      }
      const runTurn = ctx.runEphemeralTurn;
      if (!runTurn) {
        return {
          content: [{ type: "text", text: "reason_segment: no side-turn/LLM primitive in this host" }],
          isError: true,
        };
      }
      const grammar = typeof p.grammar === "string" && p.grammar.length > 0 ? p.grammar : DEFAULT_GRAMMAR;
      const question = typeof p.question === "string" && p.question.length > 0 ? p.question : "State the most likely root cause.";
      const r = await coordinatedReason(grammar, fragments, async (fs) => {
        const res = await runTurn({ promptText: `${question}\n\nFindings:\n${fs.join("\n")}` });
        return {
          text: res.replyText,
          usage: {
            input: res.assistantMessage.usage?.input ?? 0,
            output: res.assistantMessage.usage?.output ?? 0,
          },
        };
      });
      return { content: [{ type: "text", text: r.output }], details: r };
    },
  });
}