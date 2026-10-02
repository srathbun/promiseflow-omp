// Chunking a completed turn into ordered step fragments, and counting how much
// sharing that surfaces vs. the whole-turn blob. Pure string analysis — no Marpa.
import { expect, test } from "bun:test";
import { flowsSharing, prefixesOf, recurringSubsegments, splitTurn, type TurnBlock } from "./split-turn.ts";

test("splitTurn emits tool and text steps in order", () => {
  const turn: TurnBlock[] = [
    { type: "text", text: "I need to make a plan." },
    { type: "tool", name: "read", args: { path: "a.py" } },
    { type: "tool", name: "grep", args: { pattern: "foo" } },
  ];
  const steps = splitTurn(turn);
  expect(steps.length).toBe(3);
  expect(steps[0]).toBe("reason:I need to make a plan.");
  expect(steps[1]).toStartWith("tool:read(");
  expect(steps[2]).toStartWith("tool:grep(");
});

test("tool args are canonicalized: key order does not change the fragment", () => {
  const a = splitTurn([{ type: "tool", name: "read", args: { path: "x", line: 1 } }]);
  const b = splitTurn([{ type: "tool", name: "read", args: { line: 1, path: "x" } }]);
  expect(a).toEqual(b);
});

test("chunking surfaces a shared step that the whole-turn blob misses", () => {
  const flowA = splitTurn([
    { type: "text", text: "investigating the MSSQL reflection bug" },
    { type: "tool", name: "read", args: { path: "sqlalchemy/types.py" } },
    { type: "tool", name: "grep", args: { pattern: "precision" } },
  ]);
  const flowB = splitTurn([
    { type: "text", text: "a different prose opening for another issue" },
    { type: "tool", name: "read", args: { path: "sqlalchemy/types.py" } },
    { type: "tool", name: "grep", args: { pattern: "scale" } },
  ]);

  const report = flowsSharing([flowA, flowB]);
  expect(report.flows).toBe(2);
  // Prose differs, so the whole-turn blobs are two distinct segments: no sharing.
  expect(report.wholeTurnDistinct).toBe(2);
  // But one step — the shared `read types.py` — is byte-identical across both flows.
  expect(report.stepsSeenAcrossFlows).toBe(1);
  // No common START, so ordered prefixes share nothing (this is the disconnected case).
  expect(report.sharedPrefixes).toBe(0);
});

test("shared prefixes surface when two flows start the same way", () => {
  const flowA = splitTurn([
    { type: "tool", name: "read", args: { path: "sqlalchemy/types.py" } },
    { type: "tool", name: "grep", args: { pattern: "precision" } },
  ]);
  const flowB = splitTurn([
    { type: "tool", name: "read", args: { path: "sqlalchemy/types.py" } },
    { type: "tool", name: "grep", args: { pattern: "scale" } },
  ]);

  const report = flowsSharing([flowA, flowB]);
  // The first step is shared, so its prefix `[read types.py]` recurs in both flows.
  expect(report.stepsSeenAcrossFlows).toBe(1);
  expect(report.sharedPrefixes).toBe(1);
  expect(prefixesOf(flowA)).toHaveLength(2);
});

test("recurringSubsegments finds mid-flow shared runs that prefix chains miss", () => {
  const flows = [
    ["reason:a", "read:t", "read:m", "grep:p"],
    ["reason:b", "read:t", "read:pool", "grep:f"],
    ["reason:c", "read:t", "read:m", "grep:d"],
    ["reason:d", "read:t", "read:pool", "grep:c"],
  ];
  const subsegments = recurringSubsegments(flows, 2);
  const joined = subsegments.map((s) => s.steps.join("|"));

  // Two distinct length-2 runs recur across 2 flows each, despite different starts.
  expect(joined).toContain("read:t|read:m");
  expect(joined).toContain("read:t|read:pool");
  // No length ≥3 run is shared (every flow's opening differs).
  expect(subsegments.some((s) => s.steps.length >= 3)).toBe(false);
});