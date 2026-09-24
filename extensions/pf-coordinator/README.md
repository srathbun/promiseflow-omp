# pf-coordinator

An [oh-my-pi] extension bundling a faithful TypeScript port of
[`promiseflow`](https://github.com/srathbun/promiseflow) — promise-based
single-flight coordination — plus Redis-backed distributed coordination.

It wraps an allowlist of read-only built-in tools with a real `async () => T`
closure driven by a `Coordinator`: concurrent identical tool calls (from the
parent agent or any task subagent in the same process) share one execution, and
followers receive the owner's result without re-running the tool. In Redis mode
(`PF_REDIS_URL`), the same deduplication spans processes.

## Layout

- `index.ts` — the omp extension shell (interception + `pf_stats` tool).
- `promiseflow/` — the port, one module per Python source file.
- `promiseflow/__tests__/` — test-equivalent coverage ported from the Python suite.
- `docs/design.md` — types, module boundaries, algorithm invariants.
- `docs/deviations.md` — every deliberate departure from the Python library and why.

## How it works

The extension re-registers each allowlisted built-in (`read`, `grep`, `glob`,
`find`, `web_search` by default) through `pi.registerTool`, with
`ctx.invokeTool` delegating to the native implementation of the same name:

```ts
execute(_id, params, signal, onUpdate, ctx) {
  const key = stableHash([info.name, params]);
  return coordinator.getOrRun(key, () => ctx.invokeTool!(params, { signal, onUpdate }));
}
```

This is single-flight execution, not latency masking: a follower never runs the
native tool. The `tool_call` hook cannot substitute a result, so it is not used
for dedup.

## Configuration

| Env var | Effect |
|---|---|
| `PF_COORDINATOR_TOOLS` | Comma-separated allowlist override (default `read,grep,glob,find,web_search`). |
| `PF_REDIS_URL` | When set, coordinate across processes via `RedisCoordinator` + `RedisBackend` (ioredis) instead of the in-process `Coordinator`. |

In Redis mode, results must be JSON-serializable: the default codec is JSON
(`JsonCodec`), a deliberate deviation from Python's pickle default — see
`docs/deviations.md`.

## Loading

```sh
omp --extension ./extensions/pf-coordinator
# or, one-time copy into the active agent dir:
#   cp -r extensions/pf-coordinator ~/.omp/agent/extensions/pf-coordinator
```

## Verification

```sh
bunx tsc --noEmit -p tsconfig.json   # typecheck
bun test                             # ported test suite
```

[oh-my-pi]: https://github.com/can1357/oh-my-pi