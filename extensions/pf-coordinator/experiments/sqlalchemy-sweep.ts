// sqlalchemy-sweep.ts — W1 probe: how much duplicate work do parallel agents doing
// SQLAlchemy issues share? Measures the segment collision per overlap configuration
// using the same snapshot of the research plan: whole-turn vs. per-step collision,
// the shared symbol core, and mid-flow shared runs.
//
//   bun extensions/pf-coordinator/experiments/sqlalchemy-sweep.ts
//
// Reads the fresh extractions from `w1-findings.json` (an array of
// `{ issue, agent, findings: string[] }`) and combines them with the two reference
// extractions already saved in `sqlalchemy-scenarios.ts`.
import { readFileSync } from "node:fs";
import { flowsSharing, recurringSubsegments } from "./split-turn.ts";
import { SCENARIO_13497, SCENARIO_13570 } from "./sqlalchemy-scenarios.ts";

interface Extraction {
  issue: string;
  agent: string;
  findings: string[];
}

const reference: Extraction[] = [
  { issue: "#13497", agent: "reference (paper)", findings: SCENARIO_13497.findings },
  { issue: "#13570", agent: "reference (paper)", findings: SCENARIO_13570.findings },
];

function loadFresh(): Extraction[] {
  try {
    const raw = readFileSync(new URL("./w1-findings.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as Extraction[]).filter((e) => Array.isArray(e.findings) && e.findings.length > 0);
  } catch (e) {
    console.error("could not load w1-findings.json:", e instanceof Error ? e.message : e);
    return [];
  }
}

function identical(flows: string[][]): boolean {
  if (flows.length < 2) return false;
  const first = JSON.stringify(flows[0]);
  return flows.every((f) => JSON.stringify(f) === first);
}

function report(name: string, description: string, flows: string[][]): void {
  const s = flowsSharing(flows);
  const whole = 1 - s.wholeTurnDistinct / s.flows;
  const step = 1 - s.stepDistinct / s.totalSteps;
  const subs = recurringSubsegments(flows, 1);
  const shared1 = subs.filter((x) => x.steps.length === 1).sort((a, b) => b.flows - a.flows);
  const shared2 = subs.filter((x) => x.steps.length >= 2);

  console.log(`\n=== ${name} — ${description} ===`);
  console.log(`flows                 : ${s.flows}`);
  console.log(`whole-turn distinct   : ${s.wholeTurnDistinct}   (collision ${whole.toFixed(2)})`);
  console.log(`steps total/distinct  : ${s.totalSteps} / ${s.stepDistinct}   (collision ${step.toFixed(2)})`);
  console.log(`converged (identical) : ${identical(flows) ? "yes" : "no"}`);
  console.log(`shared symbols        : ${shared1.map((x) => `${x.steps[0]}×${x.flows}`).join(", ") || "(none)"}`);
  if (shared2.length > 0) {
    console.log(`shared runs (≥2)      : ${shared2.map((x) => `${x.steps.join("→")}×${x.flows}`).join(", ")}`);
  }
}

const fresh = loadFresh();
const byIssue = new Map<string, Extraction[]>();
for (const e of fresh) {
  const list = byIssue.get(e.issue) ?? [];
  list.push(e);
  byIssue.set(e.issue, list);
}

const ref13497 = reference[0]!;
const ref13570 = reference[1]!;

const focus13497 = [...(byIssue.get("#13497") ?? []), ref13497];
report("FOCUSED", "3 independent agents on issue #13497", focus13497.map((e) => e.findings));

const cluster = [...(byIssue.get("#10504") ?? []), ...(byIssue.get("#8035") ?? []), ...(byIssue.get("#7415") ?? []), ref13497];
report("CLUSTERED", "one agent each on 4 SQL Server reflection issues", cluster.map((e) => e.findings));

report("DISJOINT", "#13497 (reflection) vs #13570 (pool GC)", [ref13497.findings, ref13570.findings]);