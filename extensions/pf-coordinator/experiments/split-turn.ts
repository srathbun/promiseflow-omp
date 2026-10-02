// split-turn.ts — turn a completed assistant turn into ordered reasoning steps.
//
// A turn is a list of text blocks and tool calls. The whole turn is a poor sharing
// unit: two agents' prose almost never matches byte-for-byte, so the whole-turn
// blob is a distinct segment for everyone. Splitting at the step boundary — each
// tool call and each text block becoming its own fragment — lets the *shared* steps
// (a read of the same file, an extraction of the same symbol) recur as the same key
// even when the surrounding prose differs. This is the chunking the paper's "shapes
// of sharing" section names: chain (ordered prefixes) and disconnected (a shared
// step reached from different flows).
import { canonicalJson } from "../promiseflow/index.ts";

export type TurnBlock =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args?: unknown };

/**
 * Split a turn into an ordered list of step fragments.
 *
 * A tool call becomes `tool:<name>(<canonical args>)` — canonical JSON with sorted
 * keys, so two agents issuing the same call produce the identical fragment. A text
 * block becomes `reason:<trimmed text>` (kept by default; it is the part that usually
 * differs between agents and therefore rarely shares).
 */
export function splitTurn(turn: TurnBlock[], options: { includeText?: boolean } = {}): string[] {
  const includeText = options.includeText ?? true;
  const steps: string[] = [];
  for (const block of turn) {
    if (block.type === "tool") {
      steps.push(`tool:${block.name}(${canonicalJson(block.args ?? null)})`);
    } else if (includeText) {
      const text = block.text.trim();
      if (text.length > 0) steps.push(`reason:${text}`);
    }
  }
  return steps;
}

/** Every non-empty ordered prefix of `steps` (chain segments: `[s1]`, `[s1,s2]`, …). */
export function prefixesOf(steps: string[]): string[][] {
  const prefixes: string[][] = [];
  for (let k = 1; k <= steps.length; k++) prefixes.push(steps.slice(0, k));
  return prefixes;
}

export interface FlowsSharing {
  /** Number of flows (turns) analyzed. */
  flows: number;
  /** Distinct whole-turn blobs — before chunking. */
  wholeTurnDistinct: number;
  /** Total step fragments across all flows. */
  totalSteps: number;
  /** Distinct step fragments (chunked). */
  stepDistinct: number;
  /** Step fragments seen in two or more flows (the shared core). */
  stepsSeenAcrossFlows: number;
  /** The shared step fragments themselves (two or more flows). */
  sharedSteps: string[];
  /** Distinct ordered prefixes (chain segments). */
  prefixDistinct: number;
  /** Ordered prefixes seen in two or more flows (shared chain/sub-segments). */
  sharedPrefixes: number;
}

/** Count how much sharing exists across a set of step-flows, before vs. after chunking. */
export function flowsSharing(flows: string[][]): FlowsSharing {
  const SEP = "\u001F";
  const wholeTurnDistinct = new Set(flows.map((f) => f.join(SEP))).size;

  const stepFlows = new Map<string, Set<number>>();
  const prefixFlows = new Map<string, Set<number>>();
  let totalSteps = 0;

  flows.forEach((flow, flowIndex) => {
    totalSteps += flow.length;
    for (const step of flow) {
      const owners = stepFlows.get(step) ?? new Set<number>();
      owners.add(flowIndex);
      stepFlows.set(step, owners);
    }
    for (const prefix of prefixesOf(flow)) {
      const key = prefix.join(SEP);
      const owners = prefixFlows.get(key) ?? new Set<number>();
      owners.add(flowIndex);
      prefixFlows.set(key, owners);
    }
  });

  const stepsSeenAcrossFlows = [...stepFlows.values()].filter((s) => s.size >= 2).length;
  const sharedSteps = [...stepFlows.entries()].filter(([, s]) => s.size >= 2).map(([step]) => step);
  const sharedPrefixes = [...prefixFlows.values()].filter((s) => s.size >= 2).length;

  return {
    flows: flows.length,
    wholeTurnDistinct,
    totalSteps,
    stepDistinct: stepFlows.size,
    stepsSeenAcrossFlows,
    sharedSteps,
    prefixDistinct: prefixFlows.size,
    sharedPrefixes,
  };
}

export interface Subsegment {
  /** The contiguous step sub-sequence shared across flows. */
  steps: string[];
  /** How many flows contain this sub-sequence. */
  flows: number;
}

/**
 * Notice sub-segments within a broader flow: contiguous step sub-sequences of length
 * ≥ `minLength` that appear in two or more flows, at *any* position. This is the
 * "shared core inside distinct flows" — a step or run of steps that keeps reappearing
 * even when the flows differ elsewhere — surfacing what the whole-turn blob hides.
 */
export function recurringSubsegments(flows: string[][], minLength = 1): Subsegment[] {
  const SEP = "\u001F";
  const seen = new Map<string, { steps: string[]; owners: Set<number> }>();
  flows.forEach((flow, flowIndex) => {
    for (let i = 0; i < flow.length; i++) {
      for (let j = i + minLength; j <= flow.length; j++) {
        const slice = flow.slice(i, j);
        const key = slice.join(SEP);
        let entry = seen.get(key);
        if (entry === undefined) {
          entry = { steps: slice, owners: new Set<number>() };
          seen.set(key, entry);
        }
        entry.owners.add(flowIndex);
      }
    }
  });
  return [...seen.values()]
    .filter((e) => e.owners.size >= 2)
    .map((e) => ({ steps: e.steps, flows: e.owners.size }))
    .sort((a, b) => b.steps.length - a.steps.length || b.flows - a.flows);
}