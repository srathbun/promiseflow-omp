// segment-chunk-demo.ts — what chunking a completed turn surfaces that the
// whole-turn blob does not.
//
//   bun extensions/pf-coordinator/experiments/segment-chunk-demo.ts
//
// Four synthetic "agents ripping through SQLAlchemy issues": each turn is a unique
// prose opening followed by reads and greps. The shared reads/greps recur across
// agents, but the prose differs, so the whole-turn blob is a distinct segment for
// every agent. Chunking into steps makes the shared work visible.
import { flowsSharing, splitTurn, type TurnBlock } from "./split-turn.ts";

const reason = (text: string): TurnBlock => ({ type: "text", text });
const readFile = (path: string): TurnBlock => ({ type: "tool", name: "read", args: { path } });
const grepFor = (pattern: string): TurnBlock => ({ type: "tool", name: "grep", args: { pattern } });

const turns: TurnBlock[][] = [
  [reason("MSSQL reflection drops fractional-second precision"),
    readFile("sqlalchemy/types.py"), readFile("sqlalchemy/dialects/mssql/base.py"), grepFor("precision")],
  [reason("detached connection leaks on GC"),
    readFile("sqlalchemy/types.py"), readFile("sqlalchemy/pool/base.py"), grepFor("fairy_ref")],
  [reason("column metadata differs after reflect"),
    readFile("sqlalchemy/types.py"), readFile("sqlalchemy/dialects/mssql/base.py"), grepFor("DATETIME2")],
  [reason("async engine leaves pool connections open"),
    readFile("sqlalchemy/types.py"), readFile("sqlalchemy/pool/base.py"), grepFor("close")],
];

const flows = turns.map((turn) => splitTurn(turn));
const r = flowsSharing(flows);

const wholeCollision = 1 - r.wholeTurnDistinct / r.flows;
const stepCollision = 1 - r.stepDistinct / r.totalSteps;

console.log("Segment sharing — whole turn vs. chunked steps");
console.log("──────────────────────────────────────────────────────────────");
console.log(`flows                  : ${r.flows}`);
console.log(`whole-turn distinct    : ${r.wholeTurnDistinct}   (collision ${wholeCollision.toFixed(2)})`);
console.log(`total steps (chunked)  : ${r.totalSteps}`);
console.log(`distinct steps         : ${r.stepDistinct}   (collision ${stepCollision.toFixed(2)})`);
console.log(`shared steps (2+ flows): ${r.stepsSeenAcrossFlows}`);
for (const step of r.sharedSteps) console.log(`   • ${step}`);
console.log(`ordered-prefix shared  : ${r.sharedPrefixes} (0: no agent starts with the same step)`);
console.log();
console.log("Reading: the whole turn is 4 distinct segments (0 overlap), but chunked steps");
console.log("are 16 occurrences collapsing to 11 distinct — the 3 shared reads are the dedup-");
console.log("able work a coordinator + retention would run once instead of 2–4 times.");