// Throwaway measurement: does retaining a completed result let a *sequential*
// (non-concurrent) second caller skip the work? Contrasts Ephemeral (always
// miss → recompute) with Ttl (retained → cache hit → no recompute).
import { Coordinator } from "../promiseflow/coordinator.ts";
import { Ephemeral, Ttl } from "../promiseflow/retention.ts";
import { Hooks } from "../promiseflow/observability.ts";

// A factory we can count: increments each time it actually runs.
async function runOnce(key: string, retention: "none" | "ttl", sleepMs = 0) {
  let executions = 0;
  const hooks = new Hooks({});
  const coordinator = new Coordinator({
    retention: retention === "ttl" ? new Ttl(60) : new Ephemeral(),
    hooks,
  });
  const factory = async () => {
    executions++;
    if (sleepMs) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, sleepMs);
      await promise;
    }
    return { key, n: executions };
  };
  // TWO SEQUENTIAL callers — the first completes before the second begins.
  const r1 = await coordinator.getOrRun(key, factory);
  const r2 = await coordinator.getOrRun(key, factory);
  await coordinator[Symbol.asyncDispose]?.();
  return { retention, first: r1.n, second: r2.n, executions, sameResult: r1.n === r2.n };
}

(async () => {
  const ephemeral = await runOnce("seg-1", "none");
  const ttl = await runOnce("seg-2", "ttl");
  console.log(JSON.stringify({
    ephemeral_sequential_2_callers: {
      executions: ephemeral.executions,
      firstResult_n: ephemeral.first,
      secondResult_n: ephemeral.second,
    },
    ttl_sequential_2_callers: {
      executions: ttl.executions,
      firstResult_n: ttl.first,
      secondResult_n: ttl.second,
    },
    // The claim: with retention, the second caller skips the factory entirely.
    ttl_skipped_second_execution: ttl.executions === 1,
  }, null, 2));
})();