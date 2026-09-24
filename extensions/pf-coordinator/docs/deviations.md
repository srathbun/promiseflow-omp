# PromiseFlow TypeScript Deviations from Python

This document documents all deliberate departures from the Python PromiseFlow implementation in the TypeScript port.

## Core Design Changes

| Python Behavior | TypeScript Behavior | Why | User-Visible Consequence |
|-----------------|---------------------|-----|--------------------------|
| **Pickle default codec** (`PickleCodec`) | **JSON default codec** (`JsonCodec`) | JavaScript/TypeScript ecosystem uses JSON as the standard serialization format; pickle is Python-specific and has security implications | All payloads are JSON-safe by default; users who need binary/custom objects must provide a custom `Codec` implementation |
| **Callable fingerprint via bytecode** (`co_code`) | **Callable fingerprint via `Function.prototype.toString()`** | JavaScript doesn't expose bytecode hash; `Function.prototype.toString()` provides source code representation | - Identical source code produces identical fingerprints
- Distinct closure values with same source produce identical fingerprints (weaker guarantee)
- Bytecode-based identity across processes is lost |
| **`asyncio.Lock` for critical sections** | **Synchronous critical sections with manual synchronization** | JavaScript lacks built-in async locks for synchronous invariants; must manually enforce no-await between read/write of shared state | All critical section invariants are enforced at the code level rather than runtime |
| **`asyncio.CancelledError`/`Task` cancellation** | **`AbortController` / cancel flags** | JavaScript uses `AbortController` for cancellation; `Promise.finally()` for cleanup | Cancellation points are AbortController-based; task cancellation patterns differ |
| **`time.monotonic()` for internal timing** | **`performance.now()` for internal timing** | JavaScript uses `performance.now()` for monotonic timers | Internal timing behavior is identical; no user-visible difference |
| **`time.time()` for wall clock** | **`Date.now()` for wall clock** | JavaScript uses `Date.now()` for timestamping | User-facing timestamps use wall clock; behavior is equivalent |

## Retention and State Management

| Python Behavior | TypeScript Behavior | Why | User-Visible Consequence |
|-----------------|---------------------|-----|--------------------------|
| **`Coordinator.get_or_run(..., retention=)` exists; `RedisCoordinator.get_or_run` has NO `retention` parameter** (it always uses the constructor policy) | **Both coordinators accept `retention` in `getOrRun` options; `RedisCoordinator` honors it** (per-call policy overrides constructor policy for that call's lookup and store) | `AdvancedChain` passes `retention` per segment and the README says `AdvancedChain` accepts a `RedisCoordinator`; in Python that keyword would raise `TypeError`, so the README's promise is only satisfiable by adding the parameter. Additive, so Python-style calls are unchanged. | `AdvancedChain` over `RedisCoordinator` actually gets cache-point semantics. Documented as a deliberate additive deviation. |
| **Follower `timeout` expiry raises raw `asyncio.TimeoutError`; owner timeout raises `WorkTimeoutError`** | **Both raise `WorkTimeoutError`** | No standard TS timeout error type; a single library error is what a TS developer expects. | Callers catch one error type for both roles. |
| **`RetryPolicy` / `Ttl` validation raises `ValueError`** | **Throws `RangeError`** | Closest built-in TS analogue. | `expect(() => new Ttl(0)).toThrow(RangeError)`. |
| **Sentinel objects `_MISS`, `_RETRY`, `_BUILT`, `_FAILED`** | **JavaScript `Symbol`s** | Symbols provide unique identity without collision | Sentinel behavior is identical; internal representation differs |
| **ResultStore protocol naming** (`get`/`set`/`delete`/`clear`) | **ResultStore protocol naming** (`resultGet`/`resultSet`/`resultDelete`/`resultClear`) | Python `ResultStore` uses different naming than `RedisBackend`/`RedisCoordinator` which actually use `result_get`/`result_set`/`result_delete`/`result_clear` | We unified the naming to match actual usage in `RedisCoordinator`; all `Backend` implementations must use the unified naming |

## Backend and Integration

| Python Behavior | TypeScript Behavior | Why | User-Visible Consequence |
|-----------------|---------------------|-----|--------------------------|
| **`redis.asyncio` Python client** | **`ioredis@5` Node.js client** | ioredis is the mature, feature-complete Redis client for Node.js with Lua `EVAL` support | Same Redis protocol; ioredis provides superior async/await support and subscriber mode capabilities |
| **`fakeredis` for testing** | **`ioredis-mock@8` for testing** | ioredis-mock provides comprehensive Redis mocking with Lua `EVAL` support | Test compatibility is maintained; mock supports all Redis commands used by `RedisBackend` |
| **`RedisBackend` `subscribe` uses pubsub directly** | **`RedisBackend` `subscribe` uses `client.duplicate()` for subscriber mode** | Best practice for Redis pub/sub separation; ensures clean resource management | Same external behavior; internal resource management is cleaner |

## Extension and Tool Integration

| Python Behavior | TypeScript Behavior | Why | User-Visible Consequence |
|-----------------|---------------------|-----|--------------------------|
| **`tool_call` hook for tool interception** | **`pi.registerTool()` re-registration for native tools** | OMP provides native tool re-registration via `ExtensionAPI`; this is the recommended approach | Better tool interception; followers get true single-flight without re-execution |
| **`pi.getAllTools()` availability** | **`pi.getAllTools()` availability (may throw if called too early)** | Extension API initialization timing | Documented caveat; shell registers tools on `session_start` if load-time access throws |
| **`approval: 'read'` for read-only tools** | **`approval: 'read'` preserved for read-only tools** | Maintain same approval requirements | User experience is identical; read-only tools still require read approval |

## Test Coverage Differences

| Python Test | TypeScript Test Equivalent | Why Difference Exists | |
|------------|----------------------------|---------------------|---|
| **Bytecode identity tests** (`test_chain_key_identity.py`) | **Source identity tests** (`chain.test.ts`) | JavaScript doesn't expose bytecode hash; we test `Function.prototype.toString()` identity | We document this as a weaker guarantee but functionally equivalent for most use cases |
| **`asyncio.sleep` vs `await sleep` patterns** | **`await sleep` patterns** | JavaScript async/await syntax | Behavioral difference is testing artifact; actual semantics are identical |

## Specific Implementation Deviations

### 1. Callable Fingerprint Limitation

**Python**: `callableFingerprint` hashes `__code__.co_code` which is stable across processes and distinguishes identical closures with different bytecode.

**TypeScript**: `callableFingerprint` hashes `Function.prototype.toString()` which:
- Is stable across processes only if source is identical
- Cannot distinguish between identical closure source but different captured variables
- Cannot handle arrow functions with same source but different lexical environment

**Impact**: Chain segment keys may collide for functions that should be distinct. Users should avoid identical source code for different step functions.

### 2. Critical Section Enforcement

**Python**: Uses `asyncio.Lock()` which provides atomic async critical sections.

**TypeScript**: Manual enforcement of no-await between reading and writing shared state:
```typescript
async with self._lock:
    status, value = self._retention_lookup(key, ret)
    should_refresh = status == _STALE and self._mark_refreshing(key)
```

**Impact**: TypeScript requires explicit discipline; all critical sections are manually marked with comments.

### 3. Sentinel Objects vs Symbols

**Python**: Uses `_MISS = "miss"`, `_RETRY = object()`, `_BUILT = "BUILT"`, `_FAILED = "FAILED"`

**TypeScript**: Uses `Symbol` for unique identity:
```typescript
const _MISS = Symbol("miss");
const _RETRY = Symbol("retry");
```

**Impact**: Sentinel behavior is identical but internal representation uses Symbols for type safety.

### 4. Extension Tool Re-registration

**Python**: Intercepts `tool_call` hook to register ownership

**TypeScript**: Uses `pi.registerTool()` to re-register native tools:
```typescript
pi.registerTool({
  name: "read",
  description: nativeTool.description,
  parameters: nativeTool.parameters,
  approval: "read",
  execute: async (params) => {
    const key = stableHash(["read", params]);
    return coordinator.getOrRun(key, () => ctx.invokeTool!(params, { signal, onUpdate }));
  }
});
```

**Impact**: True single-flight for followers; no re-execution of native tools.

### 5. Redis Backend Resource Management

**Python**: Direct pubsub usage

**TypeScript**: Uses `client.duplicate()` for subscriber mode:
```typescript
const subscriber = this._client.duplicate();
async for await const message of subscriber.psubscribe(channel) {
  // handle messages
}
```

**Impact**: Cleaner resource management; subscriber connection is separate from command/connection.

### 6. JSON Canonicalization Implementation

**Python**: `json.dumps(sort_keys=True, separators=(',', ':'), default=str)`

**TypeScript**: Custom recursive canonicalization:
```typescript
function canonicalize(value: any): any {
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  
  const sorted: Record<string, any> = {};
  Object.keys(value)
    .sort()
    .forEach(key => {
      sorted[key] = canonicalize(value[key]);
    });
  
  return sorted;
}
```

**Impact**: Identical behavior; TypeScript implementation handles more edge cases.

## Migration Guidance

### For Users Migrating from Python

1. **Payload Serialization**: All payloads must be JSON-safe by default. Use custom `Codec` for binary data.

2. **Function Identity**: For identical source functions with different captured variables, use unique names rather than relying on bytecode hashing.

3. **Extension Development**: Tool interception works via `pi.registerTool()` rather than hooks.

4. **Critical Sections**: Some coordination invariants are enforced manually rather than via async locks.

### For Implementers

1. **TypeScript Type Safety**: Use strict typing to catch violations of critical section invariants.

2. **Resource Management**: Always clean up async iterators and abort controllers.

3. **Canonical JSON**: Ensure recursive key sorting matches Python's `json.dumps(sort_keys=True)`.  

4. **Error Wrapping**: Wrap JavaScript errors appropriately to match Python's exception hierarchy.

---

*End of Deviations Document*