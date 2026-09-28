// Throwaway measurement: how many citations did 4 independent extractors
// coincidentally rediscover (collision rate), and what does single-flight
// coordination save over those sets?
import { Coordinator } from "../promiseflow/coordinator.ts";
import { Ephemeral } from "../promiseflow/retention.ts";
import { Hooks } from "../promiseflow/observability.ts";
import { stableHash } from "../promiseflow/keying.ts";

type Citation = { firstAuthor: string; title: string; year: number };
// Canonical citation identity: author + title + year, normalized.
const norm = (c: Citation) =>
  `${c.firstAuthor.toLowerCase()}|${c.title.toLowerCase().replace(/[^a-z0-9 ]/g, "")}|${c.year}`;

// The 4 agents' extracted sets (verbatim from their reports).
const core: Citation[] = [
  { firstAuthor: "earley", title: "an efficient context-free parsing algorithm", year: 1970 },
  { firstAuthor: "kegler", title: "marpa a practical general parser", year: 2012 },
  { firstAuthor: "aycock", title: "practical earley parsing", year: 2002 },
  { firstAuthor: "rathbun", title: "parallel processing with promises", year: 2014 },
];
const all13: Citation[] = [
  ...core,
  { firstAuthor: "scott", title: "gll parsing", year: 2010 },
  { firstAuthor: "ford", title: "packrat parsing simple powerful lazy linear time", year: 2002 },
  { firstAuthor: "tomita", title: "efficient parsing for natural language", year: 1986 },
  { firstAuthor: "lang", title: "deterministic techniques for efficient non-deterministic parsers", year: 1974 },
  { firstAuthor: "go", title: "singleflight", year: 0 },
  { firstAuthor: "zheng", title: "sglang efficient execution of structured language model programs", year: 2023 },
  { firstAuthor: "packer", title: "memgpt towards llms as operating systems", year: 2023 },
  { firstAuthor: "xie", title: "sglang hicache fast hierarchical kv caching", year: 2025 },
  { firstAuthor: "huang", title: "unified radix cache one tree for hybrid model prefix caching", year: 2026 },
];
// RefExtractA, C, D each returned the same 4 (subset ordering varies): core.
const agents: { name: string; found: Citation[] }[] = [
  { name: "A", found: core },
  { name: "B", found: all13 },
  { name: "C", found: core },
  { name: "D", found: core },
];

// ---- Collision-rate arithmetic (set-level) -------------------------------
const distinct: Record<string, Citation> = {};
for (const a of agents) for (const c of a.found) distinct[norm(c)] = c;
let multiAgent = 0;
for (const key of Object.keys(distinct)) {
  const count = agents.filter((a) => a.found.some((c) => norm(c) === key)).length;
  if (count >= 2) multiAgent++;
}
const totalRequests = agents.reduce((s, a) => s + a.found.length, 0);

// ---- Coordination (single-flight) ----------------------------------------
const stats = { requests: 0, executions: 0, owners: 0, followers: 0 };
const coordinator = new Coordinator({
  retention: new Ephemeral(),
  hooks: new Hooks({
    onOwner: () => { stats.owners++; },
    onFollower: () => { stats.followers++; },
  }),
});
// Each agent "demands" each citation it found; identical citations share a key.
const work = async (c: Citation) => ({ key: stableHash(norm(c)), citation: c });
await (async () => {
  // fire all requests concurrently to measure in-flight dedup
  const all: Promise<unknown>[] = [];
  for (const a of agents)
    for (const c of a.found)
      all.push(
        coordinator
          .getOrRun(norm(c), () => {
            stats.executions++;
            return work(c);
          })
          .then(() => { stats.requests++; }),
      );
  await Promise.all(all);
})();

const distinctCount = Object.keys(distinct).length;
console.log(JSON.stringify({
  agents: 4,
  totalRequests,
  distinctCitations: distinctCount,
  citationsFoundBy2plus: multiAgent,
  collisionRate_set: +(multiAgent / distinctCount).toFixed(3),
  duplicateRequestFraction: +((totalRequests - distinctCount) / totalRequests).toFixed(3),
  coordination: {
    requests: stats.requests,
    executions: stats.executions,
    owners: stats.owners,
    followers: stats.followers,
    skipped: stats.requests - stats.executions,
  },
  coreCollisions: core.map((c) => norm(c)),
}, null, 2));