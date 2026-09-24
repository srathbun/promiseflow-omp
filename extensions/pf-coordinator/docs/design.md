# PromiseFlow TypeScript Design

## Module Map

The following TypeScript modules in `extensions/pf-coordinator/promiseflow/` correspond to Python modules in `.reference/promiseflow/src/promiseflow/`:

| TypeScript Module | Python Module | Import Dependencies |
|------------------|---------------|---------------------|
| `index.ts` | `__init__.py` | All other modules in `promiseflow/` |
| `coordinator.ts` | `coordinator.py` | `entry.ts`, `exceptions.ts`, `observability.ts`, `retention.ts`, `retry.ts`, `types.ts` |
| `redis-coordinator.ts` | `redis_coordinator.py` | `backends.ts`, `exceptions.ts`, `observability.ts`, `retention.ts`, `retry.ts`, `types.ts` |
| `backends.ts` | `backends.py` | (no dependencies; pure interfaces) |
| `redis-backend.ts` | `redis_backend.py` | `backends.ts` (implements `Backend`), `ioredis` types |
| `chain.ts` | `chain.py` | `types.ts` (`CoordinatorLike`), `keying.ts`, `retry.ts` |
| `advanced-chain.ts` | `advanced_chain.py` | `types.ts` (`CoordinatorLike`), `keying.ts`, `retention.ts` |
| `retention.ts` | `retention.py` | (no dependencies) |
| `retry.ts` | `retry.py` | (no dependencies) |
| `keying.ts` | `keying.py` | (no dependencies) |
| `observability.ts` | `observability.py` | (no dependencies) |
| `exceptions.ts` | `exceptions.py` | (no dependencies) |
| `entry.ts` | `entry.py` | (no dependencies) |
| `types.ts` | `types.py` | `retention.ts`, `retry.ts` (type-only imports) — defines `WorkFactory<T>`, `StepFn`, `GetOrRunOptions`, `CoordinatorLike` |

**Note:** `advanced-chain.ts` and `chain.ts` depend only on the structural `CoordinatorLike` interface (defined in `types.ts`) so they accept both `Coordinator` and `RedisCoordinator`. Neither chain module imports `coordinator.ts`.

## Public TypeScript Signatures

### `CoordinatorLike` Interface

```typescript
interface CoordinatorLike<T = unknown> {
  getOrRun(
    key: string,
    workFactory: () => Promise<T>,
    options?: {
      timeout?: number;
      retry?: RetryPolicy;
      heartbeatInterval?: number;
      retention?: RetentionPolicy;
    }
  ): Promise<T>;
}
```

### `Coordinator<T>`

```typescript
class Coordinator<T = unknown> {
  constructor(
    options?: {
      staleAfter?: number;
      sweepInterval?: number;
      retention?: RetentionPolicy;
      hooks?: Hooks;
    }
  );
  
  start(): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  
  invalidate(key: string): void;
  clear(): void;
  
  getOrRun(
    key: string,
    workFactory: () => Promise<T>,
    options?: {
      timeout?: number;
      retry?: RetryPolicy;
      heartbeatInterval?: number;
      retention?: RetentionPolicy;
    }
  ): Promise<T>;
}
```

### `RedisCoordinator<T>`

```typescript
class RedisCoordinator<T = unknown> {
  constructor(
    backend: Backend,
    options?: {
      channel?: string;
      retention?: RetentionPolicy;
      staleAfter?: number;
      heartbeatInterval?: number;
      payloadTtl?: number;
      hooks?: Hooks;
    }
  );
  
  start(): Promise<void>;
  close(): Promise<void>;
  
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
  
  getOrRun(
    key: string,
    workFactory: () => Promise<T>,
    options?: {
      timeout?: number;
      retry?: RetryPolicy;
      heartbeatInterval?: number;
      retention?: RetentionPolicy;
    }
  ): Promise<T>;
}
```

### `RetentionPolicy` Interface

```typescript
interface RetentionPolicy {
  retain: boolean;
  lifetime: number | null;
  staleWhileRevalidate: boolean;
}
```

### Retention Policy Classes

```typescript
class Ephemeral implements RetentionPolicy {
  readonly retain = false;
  readonly lifetime: number | null = null;
  readonly staleWhileRevalidate = false;
}

class Manual implements RetentionPolicy {
  readonly retain = true;
  readonly lifetime: number | null = null;
  readonly staleWhileRevalidate = false;
}

class Ttl implements RetentionPolicy {
  constructor(lifetime: number);
  readonly lifetime: number;
  readonly retain = true;
  readonly staleWhileRevalidate = false;
}

class StaleWhileRevalidate implements RetentionPolicy {
  constructor(lifetime: number);
  readonly lifetime: number;
  readonly retain = true;
  readonly staleWhileRevalidate = true;
}
```

### `RetryPolicy`

```typescript
class RetryPolicy {
  constructor(
    options?: {
      maxAttempts?: number;
      baseDelay?: number;
      maxDelay?: number;
      multiplier?: number;
    }
  );
  
  readonly maxAttempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly multiplier: number;
  
  delayForAttempt(attemptNumber: number): number;
  sleepBeforeAttempt(attemptNumber: number): Promise<void>;
}
```

### `Hooks`

```typescript
class Hooks {
  onOwner?: (key: string) => void | Promise<void>;
  onFollower?: (key: string) => void | Promise<void>;
  onCacheHit?: (key: string) => void | Promise<void>;
  onSuccess?: (key: string, elapsed: number) => void | Promise<void>;
  onError?: (key: string, error: Error) => void | Promise<void>;
  onStale?: (key: string) => void | Promise<void>;
  onRetry?: (key: string, attempt: number) => void | Promise<void>;
  
  emit(name: string, ...args: any[]): Promise<void>;
}
```

### Exceptions

```typescript
class ParallelPromisesError extends Error {
  constructor(message: string);
}

class WorkTimeoutError extends ParallelPromisesError {
  constructor(message: string);
}

class RetryExhaustedError extends ParallelPromisesError {
  constructor(message: string, cause?: Error);
}

class WorkerStaleError extends ParallelPromisesError {
  constructor(message: string);
}
```

### Keying Functions

```typescript
function stableHash(value: any): string;
function callableFingerprint(fn: Function): string;
```

### `WorkEntry`

```typescript
class WorkEntry<T> {
  constructor(
    future: Promise<T>,
    ownerToken: object,
    lastHeartbeat?: number
  );
  readonly future: Promise<T>;
  readonly ownerToken: object;
  lastHeartbeat: number;
}
```

### `Chain<T>`

```typescript
class Chain<T = unknown> {
  constructor(coordinator: CoordinatorLike);
  
  add(stepName: string, step: (input: any) => Promise<any>): Chain<T>;
  
  run(
    initial?: any,
    options?: {
      retry?: RetryPolicy;
    }
  ): Promise<any>;
}
```

### `AdvancedChain<T>`

```typescript
class AdvancedChain<T = unknown> {
  constructor(
    coordinator: CoordinatorLike,
    options?: {
      cachePointMode?: CachePointMode;
      cachePointRetention?: RetentionPolicy;
      enableUncachedTail?: boolean;
    }
  );
  
  add(
    stepName: string,
    step: (input: any) => Promise<any>,
    options?: {
      isCachePoint?: boolean;
      uncachedTail?: boolean;
    }
  ): AdvancedChain<T>;
  
  run(initial?: any): Promise<any>;
  
  cacheStatus(): {
    totalSteps: number;
    cachePoints: number;
    uncachedTailSteps: number;
    cachePointMode: string;
    uncachedTailEnabled: boolean;
  };
}
```

### `CachePointMode`

```typescript
enum CachePointMode {
  CACHE_POINTS_ONLY = "cache_points_only";
  FULL_CHAIN = "full_chain";
}
```

### Backend Interfaces

```typescript
interface LockBackend {
  acquire(key: string, token: string, ttl: number): Promise<boolean>;
  renew(key: string, token: string, ttl: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  owner(key: string): Promise<string | null>;
}

interface PayloadStore {
  put(key: string, token: string, value: any, ttl?: number): Promise<void>;
  take(key: string, token: string): Promise<any | null>;
  discard(key: string, token: string): Promise<void>;
}

interface ResultStore {
  // Python's ResultStore protocol names these get/set/delete/clear, but RedisBackend,
  // RedisCoordinator and the test FakeBackend all use result_get/result_set/
  // result_delete/result_clear. TS follows the *used* names (camelCase) so the
  // Backend aggregate has no collisions with PayloadStore.put/take.
  resultGet(key: string): Promise<unknown | null>;
  resultSet(key: string, value: unknown, ttl?: number): Promise<void>;
  resultDelete(key: string): Promise<void>;
  resultClear(): Promise<void>;
}

interface MessageBus {
  publish(channel: string, message: string): Promise<void>;
  /** Async iterable of raw messages. Consumers call `return()` (via for-await break) to unsubscribe. */
  subscribe(channel: string): AsyncIterable<string> & AsyncIterator<string>;
}

interface Backend extends LockBackend, PayloadStore, ResultStore, MessageBus {}
```

### `RedisBackend`

```typescript
class RedisBackend implements Backend {
  constructor(
    client: Redis,                    // ioredis instance
    options?: {
      namespace?: string;             // default "promiseflow"
      codec?: Codec;                  // default new JsonCodec()
    }
  );
  // key formats: `${ns}:lock:${key}`, `${ns}:payload:${key}:${token}`, `${ns}:result:${key}`
  // acquire: SET lockKey token PX ttlMs NX
  // renew / release: Lua scripts verbatim from redis_backend.py (GET==ARGV[1] → PEXPIRE / DEL)
  // subscribe: uses client.duplicate() for subscriber mode; unsubscribe+quit on iterator return()
  // resultClear: SCAN MATCH `${ns}:result:*` then DEL
  acquire(key: string, token: string, ttl: number): Promise<boolean>;
  renew(key: string, token: string, ttl: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  owner(key: string): Promise<string | null>;
  put(key: string, token: string, value: unknown, ttl?: number): Promise<void>;
  take(key: string, token: string): Promise<unknown | null>;
  discard(key: string, token: string): Promise<void>;
  resultGet(key: string): Promise<unknown | null>;
  resultSet(key: string, value: unknown, ttl?: number): Promise<void>;
  resultDelete(key: string): Promise<void>;
  resultClear(): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string): AsyncIterable<string> & AsyncIterator<string>;
}
```

### `Codec` Interface

```typescript
interface Codec {
  dumps(value: unknown): string;   // JSON text; Redis stores it as a string value
  loads(data: string): unknown;
}
```

### `JsonCodec`

```typescript
class JsonCodec implements Codec {
  dumps(value: unknown): string;   // JSON.stringify
  loads(data: string): unknown;    // JSON.parse
}
```

## Algorithm Invariants

### Coordinator Invariants

Derived from `coordinator.py` lines 1-325:

1. **Claim-or-join**: When `get_or_run` is called, the coordinator atomically checks if a key has an active, non-completed work entry. If not, the caller becomes owner with a new token; otherwise, they join as a follower waiting on the shared future.

2. **Owner-token guarded resolve/reject**: Only the owner token can resolve or reject the shared future. After handover, late resolve/reject attempts are ignored.

3. **Heartbeat updates**: The owner periodically updates `lastHeartbeat` in its `WorkEntry`. This is protected by the coordinator's lock to ensure atomic read-modify-write.

4. **Sweeper marks stale**: When `now - lastHeartbeat >= staleAfter`, the sweeper cancels the stale entry's future with `WorkerStaleError` and emits `onStale`. This is synchronous (no await between lock acquisition and mutation).

5. **Retention lookup states**: The `_retention_lookup` method returns `_MISS` (no usable cached value), `_HIT` (fresh/manual), or `_STALE` (expired under stale-while-revalidate). The fast path uses the coordinator's lock for atomic reads.

6. **Refresh slot set**: Background refresh is coordinated via `_refreshing` set to prevent stampedes.

7. **Follower retry-on-stale loop**: A follower awaits the shared future. If it rejects with `WorkerStaleError` (or any other error), the follower records `lastError` and proceeds to the next retry attempt (re-claiming; it may become owner). If the follower's own `timeout` elapses (`asyncio.TimeoutError` from `wait_for`), that timeout error propagates immediately — followers do NOT convert it to `WorkTimeoutError` and do NOT retry. TS: raise `WorkTimeoutError` for the follower timeout too (Python's raw `asyncio.TimeoutError` has no TS equivalent), and document that in deviations.md.

8. **Retry exhaustion**: After all retry attempts are exhausted, `RetryExhaustedError` is raised with the last error as `cause`.

9. **Owner timeout**: When the owner's work exceeds `timeout`, the owner rejects the entry with `WorkTimeoutError`, emits `onError`, records it as `lastError`; if this was the final attempt it raises `WorkTimeoutError` directly (NOT `RetryExhaustedError`). Non-timeout owner errors on the final attempt surface as `RetryExhaustedError` with `cause` = the error.

10. **Critical section invariants**: In Python every read-modify-write of `_entries`, `_results`, `_refreshing` happens under `asyncio.Lock`. In JS the equivalent is: those sections contain no `await` (claim-or-join, resolve-if-owner, reject-if-owner, heartbeat tick, sweeper scan, retention lookup + mark-refreshing). The sweeper emits `onStale` only after the scan finishes, outside the critical section.

11. **Sweeper schedule**: A loop `while (!closed) { await sleep(sweepInterval); cutoff = now - staleAfter; ... }`. `close()` sets `closed`, cancels the pending sleep, and awaits loop exit. `start()` is idempotent. Owner heartbeat: `while (true) { await sleep(interval); if entry missing/other owner/settled → return; entry.lastHeartbeat = now }`, cancelled in the owner's `finally`.

12. **Future exception consumption**: Python attaches a done-callback that consumes the future's exception so an un-awaited rejected future never warns. TS: attach `promise.catch(() => {})` to the internal shared promise at creation (return the original promise to callers).

### RedisCoordinator Invariants

Derived from `redis_coordinator.py` (all 314 lines):

1. **Owner path order**: When owner successfully completes, it puts payload → publishes `BUILT` → releases lock. This order ensures followers see the completion before fetching.

2. **Failure path**: If owner fails, it publishes `FAILED` → releases lock, causing followers to retry the claim.

3. **Follower wait-slice loop**: Followers wait for ownership, then slice-wait with liveness recheck after each timeout to handle crashed owners.

4. **Waiter map**: Followers are tracked in a map keyed by `(key, ownerToken)` for efficient wake-up via pub/sub listener.

5. **Listener decode**: The listener decodes JSON `{event, key, token}` frames from Redis pub/sub.

6. **_RETRY sentinel**: When follower sees `FAILED` or loses ownership, it returns `_RETRY` sentinel to trigger retry.

7. **Timeout handling**: Each follower wait-slice uses `slice_timeout = timeout || stale_after` for bounded wait.

8. **Namespace prefixing**: All Redis keys are prefixed with namespace to isolate different applications.

## Chain/AdvancedChain Key Derivation

**Chain Key Derivation** (from `chain.py`):
- Each segment key = `hash(initial, segment_path, fingerprints)`
- `segment_path`: tuple of step names accumulated in order
- `fingerprints`: tuple of `callableFingerprint(step_fn)` for each step
- `callableFingerprint`: combines qualified name + hash of `__code__.co_code`
- Uses Python `json.dumps(sort_keys=True, separators=(',',':'), default=str)` for canonical serialization

**AdvancedChain Key Derivation** (from `advanced_chain.py`):
- Identical to Chain key derivation but folds the *forwarded value* (`value`) into each segment key
- When an upstream retained result recomputes to a different value, downstream segment keys change and recompute (cascade rebuild)
- Uses the same canonical JSON serialization with recursive object key sorting

**TypeScript Canonical JSON Implementation**:
- Recursive function that sorts object keys and uses `String(x)` fallback for non-JSON values
- Tuples become arrays
- Maintains exact determinism required for distributed coordination

## Extension Shell Contract

### Extension Entry Point

`extensions/pf-coordinator/index.ts` is the OMP extension shell:

```typescript
export default function (pi: ExtensionAPI): void {
  // Extension initialization
}
```

### Tool Interception Design

The extension shell re-registers each allowlisted built-in read-only tool via `pi.registerTool()` and delegates to the native implementation through `ctx.invokeTool`. This is the ONLY interception mechanism; the `tool_call`/`tool_result` hooks are not used for dedup (a `tool_call` handler can only block or rewrite input, never substitute a result).

```typescript
const READ_ONLY_TOOLS = ["read", "grep", "glob", "find", "web_search"] as const;

function register(pi: ExtensionAPI, coordinator: Coordinator<AgentToolResult>) {
  for (const info of pi.getAllTools()) {
    if (!READ_ONLY_TOOLS.includes(info.name)) continue;
    pi.registerTool({
      name: info.name,
      label: info.name,
      description: info.description,
      parameters: info.parameters,          // copied native schema
      approval: "read",
      async execute(_id, params, signal, onUpdate, ctx) {
        if (!ctx.invokeTool) throw new Error(`no native ${info.name} to delegate to`);
        const key = stableHash([info.name, params]);
        return coordinator.getOrRun(key, () => ctx.invokeTool!(params, { signal, onUpdate }));
      },
    });
  }
}
```

Timing: `pi.getAllTools()` may throw `ExtensionRuntimeNotInitializedError` during synchronous factory load. The shell MUST attempt registration at load and, on that error, defer to the first `session_start` event (guarded so it registers once). Followers never execute the native tool; they receive the owner's `AgentToolResult` object by reference (in-process, Ephemeral retention — the result object is not mutated by the host after return).

`signal`: a follower's abort must not cancel the owner's work. Pass only the owner's signal into `invokeTool`; a follower whose signal aborts rejects its own await (race the shared promise against an abort promise) while the owner continues.

### Extension Coordination

1. **Single Coordinator Instance**: created at factory load: `new Coordinator<AgentToolResult>({ retention: new Ephemeral(), staleAfter: 60, sweepInterval: 1, hooks })`. `start()` is called from `session_start`; `close()` from `session_shutdown`. Timers inside the coordinator are plain `setTimeout` wrapped in try/catch (the coordinator is library code and must not depend on `ctx`).

2. **Stats**: `hooks` increments counters `{ owner, follower, cacheHit, success, error, stale, retry }`. `pf_stats` tool (`pi.registerTool`, `approval: "read"`, `parameters: z.object({})`) returns them as text + `details`.

3. **Configuration**: `PF_COORDINATOR_TOOLS` env var (comma-separated) overrides the allowlist; `PF_REDIS_URL` env var, when set, builds `new RedisBackend(new Redis(url), { namespace: "omp-pf" })` and a `RedisCoordinator` instead of the in-process `Coordinator` (results must then be JSON-safe; `AgentToolResult` is).
### Stub Contract

Minimum exports that the extension shell imports from `promiseflow/index.ts`:

```typescript
import {
  Coordinator,
  RedisCoordinator,
  RedisBackend,
  JsonCodec,
  Ephemeral,
  Hooks,
  stableHash,
  type CoordinatorLike,
} from "./promiseflow/index.ts";
```

## Implementation Notes

1. **Time Units**: The public API uses SECONDS throughout (`staleAfter=10.0`, `sweepInterval=1.0`, `payloadTtl=60.0`). Internal conversions to milliseconds are implementation detail.

2. **Cancellation**: Use `AbortController` or a cancel flag on heartbeat/sweeper loops instead of `asyncio.CancelledError`.

3. **Sync Critical Sections**: Some invariants (e.g., checking and updating `entries`/`results`) must remain synchronous (no `await` between read and write) as enforced by Python's `asyncio.Lock`.

4. **Error Handling**: JavaScript async error handling differs from Python's exception hierarchy. Ensure proper error wrapping and propagation.

5. **Memory Management**: Implement proper cleanup of async iterators and tasks to prevent resource leaks.

---

*End of Design Note*