# promiseflow-omp

A TypeScript port of [promiseflow](https://github.com/srathbun/promiseflow) — promise-based single-flight coordination — with Redis-backed distributed coordination, bundled as an [oh-my-pi] extension for omp.

## What it does

This repository contains two sibling research efforts:

1. **Single-flight coordination.** A faithful TypeScript port of `promiseflow` (`extensions/pf-coordinator/promiseflow/`), exposing a `Coordinator` that runs concurrent identical work items once and hands the result to every follower. A Redis variant (`RedisCoordinator` + `RedisBackend`, via `ioredis`) extends the same deduplication across processes.

2. **Paper experiments.** Aristotle–Marpa parse-deduplication experiments (`extensions/pf-coordinator/experiments/`) that use the single-flight coordinator to deduplicate Marpa parses and LLM continuation turns across concurrent agents.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [Node.js](https://nodejs.org) >= 22 (for typechecking only)

No local Redis is required to install or run the test suite — the Redis tests run against `ioredis-mock` (in-memory). A real Redis is only needed to exercise the extension's cross-process coordination at runtime (see [`PF_REDIS_URL`](#configuration)).

## Install

```sh
bun install
```

## Test

```sh
bun test
```

All tests, including the distributed-coordination tests, run in-process; no external services are required.

## Typecheck

```sh
bunx tsc --noEmit
```

## Loading the extension in omp

Load the coordinator extension:

```sh
omp --extension ./extensions/pf-coordinator
```

Load the experiment tool (the coordinated parse exposed as an LLM-callable tool):

```sh
omp --extension ./extensions/pf-coordinator/experiments/parse-segment-extension.ts
```

## Configuration

| Env var | Effect |
|---|---|
| `PF_COORDINATOR_TOOLS` | Comma-separated allowlist override (default `read,grep,glob,find,web_search`). |
| `PF_REDIS_URL` | When set, coordinate across processes via `RedisCoordinator` + `RedisBackend` (ioredis) instead of the in-process `Coordinator`. |

`PF_REDIS_URL` configures the extension at runtime; it is not read by the test suite.

## Paper experiments

The experiments live in `extensions/pf-coordinator/experiments/`:

- **`segment-key.ts`** — the deterministic identity of a parser computation. A "segment" is `parse_once(grammar, [fragment 1..n])`, keyed from the known inputs (grammar + ordered fragment prefix) before the parse runs, so independent sessions reaching the same prefix converge on the same single-flight key.
- **`marpa-client.ts`** — a minimal JSONL client for the Marpa worker's stateless `parse_once` op (the external process reached via `MARP_WORKER` / `MARP_PERL`).
- **`parse-segment.ts`** / **`parse-segment-extension.ts`** — the coordinated parse and the omp extension exposing it as an LLM-callable tool (`coordinatedReason` for LLM continuations, `parseSegment` for Marpa compute).
- **`resolve-coordinator.ts`** (with `resolvable-parse.ts`, `grammars.ts`) — PromiseFlow wiring for the ambiguous-prefix detect → extend → reparse loop; N sessions at the same ambiguous prefix share one disambiguation execution.
- **`sqlalchemy-scenarios.ts`** — a scenario harness: real SQLAlchemy problem-states (grammar + deterministic ordered finding set) that drive N concurrent agents through `parseSegment` and `coordinatedReason`, plus a ledger to measure dedup (forest parses and saved LLM tokens).

The experiments are driven by `bun test` (e.g. `parse-segment.test.ts`, `segment-coordinator.test.ts`, `segment-resolve.test.ts`) and the scenario harness `sqlalchemy-scenarios.ts`.

[oh-my-pi]: https://github.com/can1357/oh-my-pi