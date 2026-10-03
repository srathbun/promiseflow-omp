// long-horizon.ts — measure the multi-turn fix task: turn counts, and whether agents
// converge on the shared component vocabulary over a long code-grounded task.
//
//   bun extensions/pf-coordinator/experiments/long-horizon.ts
import { readFileSync } from "node:fs";

interface AgentResult {
  agent: string;
  turns: number;
  segments: string[];
  files: string[];
}

function load(): AgentResult[] {
  const raw = readFileSync(new URL("./long-horizon-findings.json", import.meta.url), "utf8");
  return JSON.parse(raw) as AgentResult[];
}

const agents = load();

console.log("Turn counts (multi-turn fix task)");
let total = 0;
for (const a of agents) {
  total += a.turns;
  console.log(`  ${a.agent}: ${a.turns} turns, ${a.segments.length} engaged symbols, edited ${a.files.length} file(s)`);
}
console.log(`  total ${total}, mean ${(total / Math.max(1, agents.length)).toFixed(0)}`);

const sets = agents.map((a) => new Set(a.segments));
const union = new Set<string>();
for (const s of sets) for (const x of s) union.add(x);

// Shared core: symbols engaged by >=2 agents.
const shared = new Set<string>();
for (const x of union) {
  let count = 0;
  for (const s of sets) if (s.has(x)) count++;
  if (count >= 2) shared.add(x);
}

console.log("\nCross-agent convergence on the component vocabulary");
console.log(`  distinct engaged symbols : ${union.size}`);
console.log(`  shared (>=2 agents)      : ${shared.size}  (${((shared.size / union.size) * 100).toFixed(0)}% of union)`);
console.log(`  shared core              : ${[...shared].sort().join(", ")}`);

for (let i = 0; i < sets.length; i++) {
  for (let j = i + 1; j < sets.length; j++) {
    const a = sets[i]!;
    const b = sets[j]!;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const jaccard = inter / new Set([...a, ...b]).size;
    console.log(`  ${agents[i]!.agent}∩${agents[j]!.agent} Jaccard ${jaccard.toFixed(2)} (${inter} shared)`);
  }
}

// Over turns: symbols >=2 agents have engaged among their first t segments.
const maxT = Math.max(...agents.map((a) => a.segments.length));
console.log("\nShared core discovered vs. turn (prefix)");
for (let t = 1; t <= maxT; t += 3) {
  const engaged = new Set<string>();
  for (const x of union) {
    let count = 0;
    for (const a of agents) if (a.segments.slice(0, t).includes(x)) count++;
    if (count >= 2) engaged.add(x);
  }
  console.log(`  by turn ${String(t).padStart(2)}: ${engaged.size} shared symbols`);
}