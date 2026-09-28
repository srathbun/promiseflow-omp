# Feeding completed OMP turns into an incremental Aristotle parser

Goal: find the smallest extension/core hook at which a **completed LLM response** can be
fed into an incremental Marpa/Aristotle parser, and at which the resulting **parser state can
influence the next agent-loop action**. No behavior is changed here; this is an analysis of
what the current OMP extension surface already supports and what it cannot.

Scope of "Aristotle" = `F:\aristotle` (the `reason` tool + Marpa worker: `add`/`parse`/`execute`
ops over versioned grammars, persistent via `appendEntry`). Scope of "PromiseFlow" = the
TypeScript port in `extensions/pf-coordinator/promiseflow` (`Coordinator.getOrRun(key, work)`).

Sources are the installed package under
`F:\promiseflow-omp\node_modules\@oh-my-pi\` (full source, not just `.d.ts`), plus the OMP
docs (`omp://extensions.md`, `omp://sdk.md`, `omp://provider-streaming-internals.md`).

---

## 1. TL;DR

| Capability | Available via extension API today? | Evidence |
|---|---|---|
| **Persist per-agent parser state across turns** | **Yes.** `pi.appendEntry(customType, data)` + rebuild from `ctx.sessionManager.getBranch()`. Per-agent = per `AgentSession`; each agent (main and every subagent) has its own `SessionManager`. | `extensions.md` "Session and state patterns"; already implemented in `F:\aristotle\src\state.ts` (`STATE_CUSTOM_TYPE`, `StateStore`, `rebuildStates`). |
| **Observe completed assistant responses *and* subsequent tool results** | **Yes.** `message_end` delivers the final assistant message (detached snapshot); `tool_result` delivers each tool result (post-exec, mutable). | `types.ts` `MessageEndEvent` / `ToolResultEvent`; `agent-session.ts` `#handleAgentEvent`. |
| **Suspend/resume the loop while awaiting an external PromiseFlow promise** | **Partially.** Only at the **tool boundary** (`pi.registerTool` `execute` awaiting `coordinator.getOrRun`), which suspends the loop for the promise's duration and feeds the result back as a `toolResult`. There is **no** extension-initiated "park the loop, await, resume" primitive. | `wrapper.ts` `ExtensionToolWrapper`; `pf-coordinator` already wraps tools with `getOrRun`. |

**Minimum core change** (only if you need *extension-initiated*, non-tool-call suspend/resume):
add **one awaited, result-bearing hook inside the agent loop** at the assistant-message/turn
boundary — e.g. `after_assistant_message` / `before_next_step` — that receives the final
assistant message + tool results, may `await` an arbitrary external promise **without the
30 s handler cap**, and returns a continuation (injected messages and/or a steer). Nothing
else in core needs to change; feed and influence are already covered by `message_end` +
`context` / `before_provider_request`.

---

## 2. The completed-turn lifecycle (event order)

One agent-loop iteration = one provider round-trip. From
`packages/agent/src/agent-loop.ts` (`agentLoop.streamAssistantResponse`) and
`packages/coding-agent/src/session/agent-session.ts` (`#handleAgentEvent`), plus the wiring
in `packages/coding-agent/src/sdk.ts`:

```text
 loop iteration
   │
   ├─ before_provider_request        ← per-request, AWAITED, can replace payload
   ├─ context                        ← per-request, AWAITED, can replace messages
   ▼
   [ provider request ] …[SSE/token streaming]…
   │  (after_provider_response      ← AWAITED but metadata-only, observation)
   ▼
   done/error → message_end           ← final AssistantMessage resolved
   │                                   (role "assistant": text + toolCall blocks)
   │
   ├─ if tool calls:  tool_call  →  tool_execution_start/update/end  →  tool_result
   │                  (each AWAITED by the wrapper; tool_call can block, tool_result can mutate)
   │                  message_end (role "toolResult") per result
   │
   ├─ turn_end                        ← { turnIndex, message, toolResults }
   ▼
   (loop continues if more tool use, else yields)
   │
   ├─ agent_end                       ← { messages, willContinue, isTerminal? }  (notification)
   ├─ session_stop                    ← AWAITED before settle; can block/continue (main session only)
   └─ retry / compaction routing      ← from the same agent_end path (TurnRecovery, SessionMaintenance)
```

Critical ordering facts that decide the design:

1. **agent-core invokes the session's agent-event subscribers fire-and-forget.** From
   `agent-session.ts`: *"agent-core invokes the event subscriber fire-and-forget, so a
   `message_end`/`agent_end` handler can still be awaiting … after `agent.waitForIdle()`
   resolves."* Consequence: `message_end`, `agent_end`, `turn_end`, `tool_execution_*` are
   **not** a blocking step of the loop. The loop has already moved on to tool dispatch or the
   next iteration by the time the session (and therefore any extension) processes them.
2. **Only four seams are synchronous and loop-affecting**: `tool_call`, `tool_result`
   (via `ExtensionToolWrapper`), `context` (`emitContext`), `before_provider_request`
   (`emitBeforeProviderRequest`), plus `before_agent_start` (policy prep, dequeue-time) and
   `session_stop` (settle-time). Everything else is notification-only.

---

## 3. The extension event surface, classified

From `src/extensibility/extensions/types.ts` and `runner.ts`.

### Synchronous, result-applied (awaited by the loop, result changes the next action)

| Event | Fires | Result | Awaited by loop? |
|---|---|---|---|
| `context` | before each LLM call (`emitContext`) | `{ messages?: AgentMessage[] }` replaces outgoing messages | **Yes** — wired as `transformContext` in `sdk.ts` |
| `before_provider_request` | before each provider request (`emitBeforeProviderRequest`) | replace raw provider payload | **Yes** — wired as `onPayload` |
| `tool_call` | pre-tool-exec | `{ block?, reason?, input? }` | **Yes** — inside `ExtensionToolWrapper` |
| `tool_result` | post-tool-exec | `{ content?, details?, isError? }` (middleware chain) | **Yes** — inside `ExtensionToolWrapper` |
| `before_agent_start` | policy prep for a prompt / dequeued batch | inject custom message | **Yes** (retried ≤3× on base change) |
| `session_stop` | main-session before settle | `{ decision:"block", reason }` or `{ continue:true, additionalContext }` (≤8 continuations) | **Yes** |

### Notification-only (fire-and-forget relative to the loop; `runner.emit` may await the handler
internally, but the loop itself is not held)

| Event | Carries | Notes |
|---|---|---|
| `message_end` | final `AgentMessage` (detached `cloneMessageEndNotification`) for roles `assistant` and `toolResult` | docstring: *"in-place changes do not rewrite agent or provider context. Persistence and subscriber delivery do not wait for this handler to finish."* **This is the completed-response observation point.** |
| `agent_end` | `{ messages, willContinue, isTerminal? }` | notification; deferred until `#promptInFlightCount === 0` |
| `turn_end` | `{ turnIndex, message, toolResults }` | fires after tools executed |
| `message_start` / `message_update` | streaming lifecycle | `message_update` carries raw `assistantMessageEvent` deltas |
| `after_provider_response` | `ProviderResponseMetadata` `{ status, headers, requestId }` | docstring: *"before its stream body is consumed."* **Metadata only — NOT the completed text.** Handler is awaited but its (void) result is discarded. |
| `tool_execution_start/update/end` | observability | — |

**The trap to avoid:** `after_provider_response` sounds like "response is complete", but it fires
when the HTTP response headers/status arrive, *before* the streamed body is read. It is an
observability hook over the provider metadata (`runner.ts` `emitAfterProviderResponse` builds the
event from `status`/`headers`/`requestId` and ignores the handler return). The completed assistant
text only exists at **`message_end`**.

---

## 4. Smallest feed → parse → influence path (no core change)

Two hooks, both already exposed, no core change:

### 4a. Feed the completed response into the parser — `message_end`

```ts
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;           // completed assistant turn
  const text = event.message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("\n");
  // await workerClient.add(stateId, text) ; await workerClient.parse(stateId)
  // persist parser state: pi.appendEntry(STATE_CUSTOM_TYPE, store.serialize());
});
```

- `message_end.role === "assistant"` gives the full final message including `toolCall` blocks
  (`content` blocks of type `"toolCall"`), so tool *calls* are also feedable; the paired
  results arrive later as `message_end.role === "toolResult"` (or via the `tool_result` event).
- Because `message_end` is a **detached snapshot, notification-only**, feeding must be a
  side effect (append to the worker, persist state). Do not try to mutate the event in place —
  it does nothing (see §3).
- Parser state is optional work carried by the session; the feed may run asynchronously.
  This is exactly the `add`/`parse` half of `reason`.

### 4b. Let parser state influence the next action — `context` (or `before_provider_request`)

```ts
pi.on("context", async (event, ctx) => {
  const store = /* rebuild or cached StateStore */;
  const emitted = /* parser's latest `emitted`/`output`, or a constraint violation */;
  if (!emitted) return;
  return { messages: [...event.messages, { role: "developer", content: emitted }] };
});
```

- `context` fires **before every LLM call**, is awaited, and its returned `{ messages }`
  replaces the outgoing context. This is the natural place to inject parser-derived context
  (e.g. the grammar's `emitted` text, or a "constraint violated — alternatives N..M" directive)
  so the **next** decision sees it.
- Equivalently `before_provider_request` can rewrite the raw wire payload (e.g. append the
  emitted text to the system prompt) — strictly more powerful, but provider-payload-shaped and
  therefore more brittle.
- The parser state read here is the *persisted* state (`appendEntry` + `getBranch()`, or a
  session-keyed in-memory cache), so the influence is stable across the asynchronous gap
  between `message_end` (feed) and `context` (influence).

Net: **`message_end` (feed, async) + `context` (influence, synchronous) = the complete
closed loop with zero changes to OMP core.** The only thing this does *not* give you is the
ability to *block* the next action synchronously while the parser or an external promise is
still working (next section).

---

## 5. The three capabilities, determined

### 5a. Persist per-agent parser state across turns — **YES**

- Durable: `pi.appendEntry(customType, data)` appends a `custom` session entry; rebuild on
  `session_start` / `session_branch` / `session_tree` by scanning
  `ctx.sessionManager.getBranch()`. Reverse-domain-qualify the `customType` (core reserves a
  small set; see `session.md`).
- Per-agent: state is anchored to a `SessionManager`. Every agent — the main session and each
  `task`/`eval agent()` subagent — has its own session file and manager; extension factories are
  rebound per child session (`preloadedPreparedExtensions`, §extension-loading), so one
  extension instance binds each agent's `pi` and `ctx.sessionManager` distinctly. `appendEntry`
  therefore lands in the agent that appended it, and `getBranch()` reads only that agent.
- Proven: `F:\aristotle\src\state.ts` already implements `STATE_CUSTOM_TYPE =
  "dev.aristotle.marpa-reasoning.state"`, `ReasoningState.serialize/deserialize`, and
  `rebuildStates(entries)` — the exact reconstruction pattern the docs recommend.
- Caveat: state survives *turns* and *resume/fork/restart* through the session file; it does
  **not** survive agent *death without session persistence* (in-memory sessions). Interactive
  and default SDK sessions are file-backed.

### 5b. Observe completed assistant responses *and* subsequent tool results — **YES**

- Completed assistant response: `message_end` with `role === "assistant"` (detached snapshot,
  includes tool-call blocks). Also available in full at `agent_end.messages` and
  `turn_end.message`.
- Subsequent tool results: `tool_result` (post-exec heredity: can patch `content` / `details` /
  `isError`), or `message_end` with `role === "toolResult"`, or `turn_end.toolResults`.
- Mind the camelCase roles: `message.role` uses `"assistant"`, `"toolResult"`, `"user"` —
  matching snake_case (`tool_result`) silently matches nothing (§session docs).

### 5c. Suspend/resume the loop waiting on an external PromiseFlow promise — **PARTIAL / NO clean primitive**

What exists:

- **Tool boundary (works today, zero core change).** `pi.registerTool`'s `execute` runs inside
  the loop's tool runner (not under the 30 s extension-handler budget). Awaiting
  `coordinator.getOrRun(key, () => externalPromise)` inside `execute` suspends the loop for the
  promise's duration; the resolved value returns as a `toolResult`, which the loop folds into
  context before the next LLM call. This is *exactly* what `reason` (Aristotle) and
  `pf-coordinator` already do. The catch: suspension is **model-initiated** — the LLM must emit
  the tool call. The parser cannot itself force a pause between turns.
- **`session_stop` blocking.** Awaited before settle; `{ decision: "block", reason }` holds the
  turn from finishing until a later hook allows it (≤8 advisory continuations; a refusal is
  unbounded-blocking until allowed or interrupted). This blocks *settlement*, not *a mid-loop
  step*, and fires only for the main session, never subagents.
- **`deliverAs` re-entry.** `pi.sendMessage(..., { deliverAs: "aside" | "steer" | "followUp" })`
  and `triggerTurn` inject a continuation at the next step boundary or start a turn when idle.
  This *resumes* a run around an external completion, but it does not *hold* the loop; the loop
  is either streaming or idle when delivery lands.

What is missing (the reason a core change is needed for extension-initiated suspend/resume):

1. **No awaited, result-bearing hook sits at the boundary between a completed assistant message
   and the next loop action.** `message_end` is notification-only (fire-and-forget), and
   `context`/`before_provider_request` are the *pre-request* seams of the *following* iteration
   — there is nothing in between that can both `await` an external promise and return a
   continuation.
2. **Every awaited handler is raced against `EXTENSION_HANDLER_TIMEOUT_MS = 30_000`**
   (`runner.ts` `raceHandlerWithTimeout`). Even the existing awaited seams cannot hold for a
   long-lived external promise without their result being discarded after 30 s. A genuine
   suspend/resume primitive must be exempt from (or extend) this budget.

---

## 6. Minimum OMP core change (only if extension-initiated suspend/resume is required)

If "suspend the loop while waiting on a PromiseFlow promise" must be **initiated by the parser
extension** (not by the model calling a tool), the smallest change is:

1. **Add one awaited, mutating event inside `agent-loop.ts`** at the completed-message/turn
   boundary, dispatched *in the loop* (not fire-and-forget). Contract (mirroring `session_stop`
   but at step granularity):

   ```ts
   type AfterStepEvent = {
     type: "after_agent_step" /* or "before_next_step" */;
     message: AssistantMessage;            // final assistant message (text + toolCall blocks)
     toolResults?: AgentMessage[];         // results executed so far this turn
     signal: AbortSignal;
   };
   type AfterStepResult =
     | { continue: true }                                  // proceed normally
     | { continue: true; messages?: AgentMessage[] }       // inject parser-derived context
     | { pause: true; resume: () => Promise<AfterStepResult> } // suspend; re-enter on resolve
   ```

2. **Run it free of the 30 s handler budget** (or give it an explicit, extendable suspension
   window), because the whole point is awaiting an unbounded external promise.

3. **Apply the returned `messages`** the same way `context` does (rewrite outgoing context
   before the next provider request), so the resolved parser state steers the next action.

That is the minimal core delta. Everything else — persistence across turns, observation of
responses and tool results, and PromiseFlow coordination (`getOrRun`) — is already available
through the extension API and already demonstrated by `reason` + `pf-coordinator`.

**Alternative with no core change:** keep suspend/resume model-driven — publish a dedicated
extension tool (e.g. `reason` or a `pf_wait` tool) whose `execute` awaits
`coordinator.getOrRun(key, () => externalPromise)` and returns the promise's value as the tool
result. The LLM's next loop step then reads it and acts. This is the boring, already-proven
path and is recommended unless the parser must preempt the model deterministically.

---

## 7. Risks / open points

- `message_end` is a **clone**; any in-memory mutation there is silently discarded. Feed must
  round-trip through durable state (worker + `appendEntry`) or a session-keyed cache, then be
  read back in `context`/`before_provider_request`.
- Feeding is asynchronous relative to the loop. If the parser must be *finished* before the
  next action, the influence hook (`context`) must block or the design must tolerate a one-step
  lag (parser state from turn N steers turn N+1). Section 6 is the only way to make it
  same-step.
- Per-agent state via closure variables in the factory is per **session-rebind**, not per
  *turn*; rely on `appendEntry`/`getBranch()` for anything that must survive fork/resume.
- `after_provider_response` should not be used as the "response complete" signal; it is
  provider metadata received before the body streams.