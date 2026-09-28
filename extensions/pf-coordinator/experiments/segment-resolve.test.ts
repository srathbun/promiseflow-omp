// Path (i): the held "detect ambiguity → update grammar → re-parse → continue"
// loop, coordinated by PromiseFlow. Real Marpa worker; deterministic overlap.
import { expect, test } from "bun:test";
import { Coordinator, Ephemeral, Hooks, createDeferred } from "../promiseflow/index.ts";
import { MarpaParseClient } from "./marpa-client.ts";
import { AMBIGUOUS_EXPR_GRAMMAR, PRECEDENCE_EXPR_GRAMMAR } from "./grammars.ts";
import { resolvePrefix, type ParseOnceClient, type ResolveOutcome } from "./resolvable-parse.ts";
import { coordinatedResolve } from "./resolve-coordinator.ts";
import { segmentKey } from "./segment-key.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const PREFIX = ["1 + 2 * 3"];

test("grammar extension resolves an ambiguous prefix (2 → 1)", async () => {
  const client = new MarpaParseClient();
  try {
    const outcome = await resolvePrefix(client, AMBIGUOUS_EXPR_GRAMMAR, PREFIX);
    expect(outcome.stage).toBe("resolved");
    expect(outcome.before.status).toBe("AMBIGUOUS");
    expect(outcome.before.valueCount).toBe(2);
    expect(new Set(outcome.before.values).size).toBe(2); // two distinct trees
    expect(outcome.after.status).toBe("VALID");
    expect(outcome.after.valueCount).toBe(1);
    expect(outcome.extendedGrammar).toBe(PRECEDENCE_EXPR_GRAMMAR);
  } finally {
    client.terminate();
  }
});

test("resolvePrefix parks on the decision deferral (the hold)", async () => {
  const client = new MarpaParseClient();
  try {
    const decision = createDeferred<void>();
    let settled = false;
    const p = resolvePrefix(client, AMBIGUOUS_EXPR_GRAMMAR, PREFIX, { decision });
    void p.then(() => {
      settled = true;
    });
    await sleep(10);
    expect(settled).toBe(false); // held: before parsed, extension not yet applied
    decision.resolve();
    const outcome = await p;
    expect(settled).toBe(true);
    expect(outcome.stage).toBe("resolved");
  } finally {
    client.terminate();
  }
});

test("unresolved: ambiguous parse with no registered resolver keeps its forest", async () => {
  const client = new MarpaParseClient();
  try {
    // Single-operator grammar with NO entry in the resolver table.
    const noResolver = AMBIGUOUS_EXPR_GRAMMAR.replace(
      "e ::= e '+' e | e '*' e | n",
      "e ::= e '+' e | n",
    );
    const outcome = await resolvePrefix(client, noResolver, ["1 + 2 + 3"]);
    expect(outcome.stage).toBe("unresolved");
    expect(outcome.before.status).toBe("AMBIGUOUS");
    expect(outcome.before.valueCount).toBe(2);
    expect(outcome.after).toEqual(outcome.before); // forest preserved, not faked
  } finally {
    client.terminate();
  }
});

test("single-flight: two concurrent callers share one detect→extend→reparse", async () => {
  const client = new MarpaParseClient();
  const counters = { owners: 0, followers: 0 };
  const coord = new Coordinator({
    retention: new Ephemeral(),
    hooks: new Hooks({
      onOwner: () => {
        counters.owners += 1;
      },
      onFollower: () => {
        counters.followers += 1;
      },
    }),
  });
  let parseOnceCalls = 0;
  let executions = 0;
  const countingClient: ParseOnceClient = {
    parseOnce: async (grammar, fragments) => {
      parseOnceCalls += 1;
      return client.parseOnce(grammar, fragments);
    },
  };
  const started = createDeferred<void>();
  const release = createDeferred<void>();

  const keyA = segmentKey({ version: 1, grammar: AMBIGUOUS_EXPR_GRAMMAR, fragments: PREFIX });
  const keyB = segmentKey({ version: 1, grammar: AMBIGUOUS_EXPR_GRAMMAR, fragments: PREFIX });
  expect(keyA).toBe(keyB);

  const work = async (): Promise<ResolveOutcome> => {
    executions += 1;
    started.resolve();
    await release.promise; // overlap latch: follower must join while owner holds
    return resolvePrefix(countingClient, AMBIGUOUS_EXPR_GRAMMAR, PREFIX);
  };

  const pA = coord.getOrRun(keyA, work);
  const pB = coord.getOrRun(keyB, work);
  await started.promise;
  await sleep(0); // drain the follower's claim microtask
  expect(coord.inflightKeys()).toContain(keyA);
  release.resolve();

  const [ra, rb] = await Promise.all([pA, pB]);
  expect(executions).toBe(1); // one resolve loop
  expect(counters.owners).toBe(1);
  expect(counters.followers).toBe(1);
  expect(parseOnceCalls).toBe(2); // before + after, exactly once
  expect(ra).toEqual(rb);
  expect(ra.stage).toBe("resolved");
  expect(ra.before.valueCount).toBe(2);
  expect(ra.after.valueCount).toBe(1);

  client.terminate();
});

test("coordinatedResolve wires the segment key + resolve loop", async () => {
  const client = new MarpaParseClient();
  try {
    const coord = new Coordinator({ retention: new Ephemeral() });
    const outcome = await coordinatedResolve(coord, client, AMBIGUOUS_EXPR_GRAMMAR, PREFIX);
    expect(outcome.stage).toBe("resolved");
    expect(outcome.after.valueCount).toBe(1);
  } finally {
    client.terminate();
  }
});