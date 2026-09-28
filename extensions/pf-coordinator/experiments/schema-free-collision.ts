// Throwaway measurement: three independent extractors were handed the corpus
// with NO output schema ("write however feels natural"). Do their findings
// collide mechanically (i.e. would segment-key hashing dedup them), or does
// free-form naming diverge even when the same works are meant?
//
// Two views:
//   (a) mechanical — lowercase + strip non-alphanumerics, compare raw strings.
//   (b) conceptual — the same works, matched by a human/grammar canonicalization.
const agents: { name: string; lines: string[] }[] = [
  {
    name: "B",
    lines: [
      "Marpa (generalized parser in the Earley tradition) - Kegler's work",
      "Parallel Processing with Promises - Rathbun",
      "Earley (algorithm/principle)",
      "Aycock-Horspool (algorithm/principle)",
      "Marpa::R2 (specific implementation of generalized parser)",
      "PromiseFlow (single-flight coordination pattern/port)",
      "Perl (used for Marpa worker implementation)",
    ],
  },
  {
    name: "C",
    lines: [
      "Marpa (Kegler/Earley)",
      "Rathbun Parallel Processing with Promises",
      "Marpa::R2",
      "Earley parser tradition",
      "Ruby Slippers (Kegler)",
      "SGLang RadixAttention",
      "MemGPT virtual memory",
      "Aristotle extension",
      "PromiseFlow coordinator",
      "Aycock-Horspool",
    ],
  },
  {
    name: "D",
    lines: [
      "Marpa (generalized parser, Earley tradition; Kegler's work)",
      "Rathbun, Parallel Processing with Promises (earlier paper)",
      "Earley (algorithm / citation)",
      "Aycock-Horspool (citation in paper)",
      "Kegler (Ruby Slippers technique)",
      "SGLang RadixAttention",
      "MemGPT virtual memory",
      "OpenRouter (provider / usage metering)",
      "SQLAlchemy (#13497 issue, as source corpus - attributed venue)",
    ],
  },
];

// Mechanical identity: lowercase, keep only [a-z0-9], collapse spaces.
const mech = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const mechCounts = new Map<string, number>();
for (const a of agents) for (const l of a.lines) {
  const k = mech(l);
  mechCounts.set(k, (mechCounts.get(k) ?? 0) + 1);
}
const totalLines = agents.reduce((s, a) => s + a.lines.length, 0);
const mechDistinct = mechCounts.size;
const mechCollided = [...mechCounts.values()].filter((c) => c >= 2).length;

// Conceptual identity: the 12 works a reader recognizes across the three lists.
const conceptual: { label: string; inAgents: string[] }[] = [
  { label: "marpa (parser family + Marpa::R2 impl)", inAgents: ["B", "C", "D"] },
  { label: "rathbun parallel processing with promises", inAgents: ["B", "C", "D"] },
  { label: "earley", inAgents: ["B", "C", "D"] },
  { label: "aycock-horspool", inAgents: ["B", "C", "D"] },
  { label: "kegler ruby slippers", inAgents: ["C", "D"] },
  { label: "sglang radixattention", inAgents: ["C", "D"] },
  { label: "memgpt", inAgents: ["C", "D"] },
  { label: "promiseflow", inAgents: ["B", "C"] },
  { label: "perl", inAgents: ["B"] },
  { label: "aristotle extension", inAgents: ["C"] },
  { label: "openrouter", inAgents: ["D"] },
  { label: "sqlalchemy 13497", inAgents: ["D"] },
];

console.log(JSON.stringify({
  usableAgents: agents.length, // a 4th agent (FreeA) derailed and returned no list
  totalLineItems: totalLines,
  mechanical: {
    distinctStrings: mechDistinct,
    stringsCollidedAcrossAgents: mechCollided,
    mechanicalCollisionRate: +(mechCollided / mechDistinct).toFixed(3),
    // near-zero: free-form naming splits same work into distinct strings
  },
  conceptual: {
    distinctWorks: conceptual.length,
    worksFoundBy2plus: conceptual.filter((c) => c.inAgents.length >= 2).length,
    conceptualCollisionRate: +(conceptual.filter((c) => c.inAgents.length >= 2).length / conceptual.length).toFixed(3),
    sharedCore: conceptual.filter((c) => c.inAgents.length === 3).map((c) => c.label),
  },
}, null, 2));