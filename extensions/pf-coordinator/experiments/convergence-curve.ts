// convergence-curve.ts — byte/set convergence vs schema tightness, per issue.
// Escalating schema strictness on the SAME issue, so we can see where (if anywhere)
// independent agents become reliably byte-identical. The dedup-relevant metric is
// pairwise: do two same-issue agents produce the identical ordered list.
//
//   bun extensions/pf-coordinator/experiments/convergence-curve.ts
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

function forIssue(name: string, issue: string): Extraction[] {
  return load(name).filter((e) => e.issue === issue);
}

function canonical(f: string[]): string {
  return [...new Set(f)].sort().join("\u001F");
}

/** Pairwise identical pairs / total pairs, byte and set. */
function pairwise(list: Extraction[]): { byte: number; set: number; pairs: number } {
  let byte = 0;
  let set = 0;
  let pairs = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      pairs++;
      if (JSON.stringify(list[i]!.findings) === JSON.stringify(list[j]!.findings)) byte++;
      if (canonical(list[i]!.findings) === canonical(list[j]!.findings)) set++;
    }
  }
  return { byte, set, pairs };
}

function row(label: string, list: Extraction[]): void {
  const p = pairwise(list);
  const byte = p.pairs === 0 ? 0 : p.byte / p.pairs;
  const set = p.pairs === 0 ? 0 : p.set / p.pairs;
  console.log(`${label.padEnd(22)}  byte ${p.byte}/${p.pairs}  (${(byte * 100).toFixed(0)}%)   set ${p.set}/${p.pairs}  (${(set * 100).toFixed(0)}%)`);
}

console.log("#13497 — pairwise convergence vs schema tightness");
row("L0 loose", forIssue("w1-findings.json", "#13497"));
row("L1 strict", forIssue("w1-findings-tight.json", "#13497"));
row("L2 very strict", forIssue("curve-l2-13497.json", "#13497"));

console.log("\n#13570 — pairwise convergence vs schema tightness");
row("L1 strict", forIssue("w1-findings-rate.json", "#13570"));
row("L2 very strict", forIssue("curve-l2-13570.json", "#13570"));