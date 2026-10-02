// convergence-rate.ts — pool the tight-schema convergence across issues to report a
// real rate instead of one issue's 2/3. Reads the raw extractions and computes:
//   • pairwise byte-convergence (two same-issue agents produce the identical list)
//   • pairwise set-convergence (identical symbol set, any order)
//   • full-group convergence (every agent on an issue byte-/set-converges)
//
//   bun extensions/pf-coordinator/experiments/convergence-rate.ts
import { readFileSync } from "node:fs";

interface Extraction {
  issue: string;
  agent: string;
  findings: string[];
}

function load(name: string): Extraction[] {
  try {
    const raw = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    return (JSON.parse(raw) as Extraction[]).filter((e) => Array.isArray(e.findings) && e.findings.length > 0);
  } catch (e) {
    console.error(`could not load ${name}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Order-insensitive canonical form of a finding list (for set equality). */
function canonical(f: string[]): string {
  return [...new Set(f)].sort().join("\u001F");
}

const all = [...load("w1-findings-tight.json"), ...load("w1-findings-rate.json")];
const byIssue = new Map<string, Extraction[]>();
for (const e of all) {
  const list = byIssue.get(e.issue) ?? [];
  list.push(e);
  byIssue.set(e.issue, list);
}

let issues = 0;
let pairs = 0;
let bytePairs = 0;
let setPairs = 0;
let fullByte = 0;
let fullSet = 0;

for (const [issue, list] of byIssue) {
  if (list.length < 2) continue;
  issues++;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      pairs++;
      if (JSON.stringify(list[i]!.findings) === JSON.stringify(list[j]!.findings)) bytePairs++;
      if (canonical(list[i]!.findings) === canonical(list[j]!.findings)) setPairs++;
    }
  }
  const ref = list[0]!.findings;
  if (list.every((e) => JSON.stringify(e.findings) === JSON.stringify(ref))) fullByte++;
  const refSet = canonical(ref);
  if (list.every((e) => canonical(e.findings) === refSet)) fullSet++;
}

const pct = (n: number) => (pairs === 0 ? 0 : ((n / pairs) * 100).toFixed(0));
console.log(`issues with >=2 agents : ${issues}  (agents: ${all.length})`);
console.log(`pairwise byte-identical: ${bytePairs}/${pairs}  (${pct(bytePairs)}%)`);
console.log(`pairwise set-identical  : ${setPairs}/${pairs}  (${pct(setPairs)}%)`);
console.log(`full-group byte         : ${fullByte}/${issues}`);
console.log(`full-group set          : ${fullSet}/${issues}`);