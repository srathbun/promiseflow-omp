// M15 deterministic experiment: does a stable Aristotle parser prefix become a
// PromiseFlow-addressable in-flight computation that runs ONCE under concurrent
// contention? Real Marpa worker + real in-process Coordinator; no timing luck.
import { expect, test } from "bun:test";
import { Coordinator, Ephemeral, Hooks, RetryPolicy, createDeferred } from "../promiseflow/index.ts";
import { segmentKey } from "./segment-key.ts";
import { MarpaParseClient, type ParseOnceResult, type ParseStatus } from "./marpa-client.ts";

// Same dangling-else grammar M14 used. k `if/then`, l `else s` → C(k,l) trees.
const GRAMMAR = [
  ":default ::= action => ::array",
  ":start ::= stmt",
  "stmt ::= 'if' 'then' stmt 'else' stmt | 'if' 'then' stmt | 's'",
  ":discard ~ whitespace",
  "whitespace ~ [\\s]+",
].join("\n");

const VERSION = 1;
const F1 = "if then if then if then s else s";
const F2 = "else s";
const F3 = "else s";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Counters {
  owners: number;
  followers: number;
  hits: number;
  errors: number;
}

function makeHooks(c: Counters): Hooks {
  return new Hooks({
    onOwner: () => {
      c.owners += 1;
    },
    onFollower: () => {
      c.followers += 1;
    },
    onCacheHit: () => {
      c.hits += 1;
    },
    onError: () => {
      c.errors += 1;
    },
  });
}

interface SingleFlightReport {
  key: string;
  executions: number;
  counters: Counters;
  result: ParseOnceResult;
}

/**
 * Fire two concurrent callers at the same prefix behind a deterministic latch so
 * the follower MUST join while the owner is still in-flight. Asserts single
 * flight, owner/follower split, and result equivalence.
 */
async function runSingleFlight(
  client: MarpaParseClient,
  prefix: string[],
  expectedStatus: ParseStatus,
  expectedCount: number,
): Promise<SingleFlightReport> {
  const counters: Counters = { owners: 0, followers: 0, hits: 0, errors: 0 };
  const coord = new Coordinator({ retention: new Ephemeral(), hooks: makeHooks(counters) });
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  let executions = 0;

  const work = async (): Promise<ParseOnceResult> => {
    executions += 1;
    started.resolve();
    await release.promise; // hold the parse in-flight until the test releases it
    return client.parseOnce(GRAMMAR, prefix);
  };

  // Two callers independently derive the same key from the same prefix.
  const keyA = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: prefix });
  const keyB = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: prefix });
  expect(keyA).toBe(keyB);

  const pA = coord.getOrRun(keyA, work);
  const pB = coord.getOrRun(keyB, work);

  await started.promise; // owner has begun the actual parse
  await sleep(0); // let the follower drain its claim microtask
  expect(coord.inflightKeys()).toContain(keyA); // one shared in-flight entry
  release.resolve();

  const [ra, rb] = await Promise.all([pA, pB]);
  expect(executions).toBe(1);
  expect(counters.owners).toBe(1);
  expect(counters.followers).toBe(1);
  expect(ra).toEqual(rb);
  expect(ra.status).toBe(expectedStatus);
  expect(ra.valueCount).toBe(expectedCount);
  return { key: keyA, executions, counters, result: ra };
}

test("segment key: same prefix → same key; distinct prefixes → distinct keys", () => {
  const k1a = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: [F1] });
  const k1b = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: [F1] });
  const k2 = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: [F1, F2] });
  const k3 = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: [F1, F2, F3] });

  expect(k1a).toBe(k1b);
  expect(new Set([k1a, k2, k3]).size).toBe(3);

  // Grammar SOURCE is part of the identity: a byte change moves the key.
  const kGrammar = segmentKey({ version: VERSION, grammar: `${GRAMMAR}#changed\n`, fragments: [F1] });
  expect(kGrammar).not.toBe(k1a);

  // Fragment ORDER is part of the identity.
  const kSwap = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: [F2, F1] });
  expect(kSwap).not.toBe(k1a);
});

test("two concurrent callers for the same prefix → one parse execution", async () => {
  const client = new MarpaParseClient();
  try {
    const r = await runSingleFlight(client, [F1, F2], "AMBIGUOUS", 3);
    expect(r.executions).toBe(1);
    expect(r.counters.owners).toBe(1);
    expect(r.counters.followers).toBe(1);
    expect(r.result.values.length).toBe(3);
  } finally {
    client.terminate();
  }
});

test("prefixes [1], [1,2], [1,2,3] → three distinct single-flight segments", async () => {
  const client = new MarpaParseClient();
  try {
    const r1 = await runSingleFlight(client, [F1], "AMBIGUOUS", 3);
    const r2 = await runSingleFlight(client, [F1, F2], "AMBIGUOUS", 3);
    const r3 = await runSingleFlight(client, [F1, F2, F3], "VALID", 1);

    // Related prefixes, but three DISTINCT computational segments.
    expect(new Set([r1.key, r2.key, r3.key]).size).toBe(3);
    // Each executed exactly once under its own concurrent contention.
    expect(r1.executions).toBe(1);
    expect(r2.executions).toBe(1);
    expect(r3.executions).toBe(1);
  } finally {
    client.terminate();
  }
});

test("concurrent failure is shared; a later request recomputes", async () => {
  const client = new MarpaParseClient();
  const counters: Counters = { owners: 0, followers: 0, hits: 0, errors: 0 };
  const coord = new Coordinator({ retention: new Ephemeral(), hooks: makeHooks(counters) });
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const noRetry = { retry: new RetryPolicy({ maxAttempts: 1 }) };
  let executions = 0;
  const prefix = [F1, F2];

  const failingWork = async (): Promise<ParseOnceResult> => {
    executions += 1;
    started.resolve();
    await release.promise;
    throw new Error("simulated parse failure");
  };

  const key = segmentKey({ version: VERSION, grammar: GRAMMAR, fragments: prefix });
  const pA = coord.getOrRun(key, failingWork, noRetry);
  const pB = coord.getOrRun(key, failingWork, noRetry);

  await started.promise;
  await sleep(0);
  release.resolve();

  const [ra, rb] = await Promise.allSettled([pA, pB]);
  expect(ra.status).toBe("rejected");
  expect(rb.status).toBe("rejected");
  expect(executions).toBe(1); // one shared failing computation; no auto-retry
  expect(counters.errors).toBe(1); // the owner's single failure was observed

  // No poisoned segment: a later healthy request recomputes under a fresh key.
  const later = await coord.getOrRun(key, async () => {
    executions += 1;
    return client.parseOnce(GRAMMAR, prefix);
  });
  expect(executions).toBe(2);
  expect(later.status).toBe("AMBIGUOUS");
  expect(later.valueCount).toBe(3);

  client.terminate();
});