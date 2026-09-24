/**
 * omp extension shell for the TypeScript promiseflow port.
 *
 * Wraps an allowlist of read-only built-in tools with single-flight
 * coordination: concurrent identical calls (from the parent agent or any task
 * subagent in the same process) share one execution; followers receive the
 * owner's result by reference without re-running the tool.
 *
 * The interception point is `pi.registerTool` + `ctx.invokeTool` (delegate to
 * the native built-in of the same name). The `tool_call` hook cannot substitute
 * a result, so it is not used for deduplication.
 *
 * Env:
 *   PF_COORDINATOR_TOOLS   comma-separated allowlist override
 *                          (default: read,grep,glob,find,web_search)
 *   PF_REDIS_URL           when set, coordinate across processes via
 *                          RedisCoordinator + RedisBackend (ioredis) instead of
 *                          the in-process Coordinator
 */
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Redis } from "ioredis";
import { Coordinator, Ephemeral, Hooks, RedisBackend, RedisCoordinator, stableHash, type CoordinatorLike } from "./promiseflow/index.ts";

interface PfCoordinator extends CoordinatorLike {
	start(): Promise<void>;
	close(): Promise<void>;
	[Symbol.asyncDispose]?(): Promise<void>;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	// Tool params arrive schema-validated and are a plain object; invokeTool
	// re-validates against the native schema.
	const record = value as Record<string, unknown>;
	return record;
}

export default function (pi: ExtensionAPI): void {
	const counters = { owner: 0, follower: 0, cacheHit: 0, success: 0, error: 0, stale: 0, retry: 0 };
	const hooks = new Hooks({
		onOwner: () => {
			counters.owner += 1;
		},
		onFollower: () => {
			counters.follower += 1;
		},
		onCacheHit: () => {
			counters.cacheHit += 1;
		},
		onSuccess: () => {
			counters.success += 1;
		},
		onError: () => {
			counters.error += 1;
		},
		onStale: () => {
			counters.stale += 1;
		},
		onRetry: () => {
			counters.retry += 1;
		},
	});

	const coordinator: PfCoordinator = buildCoordinator(hooks);

	const allowlist = /* @__PURE__ */ readAllowlist();
	const wrapped: string[] = [];
	let registered = false;

	const registerWrappers = (): void => {
		if (registered) return;
		// `getAllTools` throws before the runtime is initialized (factory load)
		// and may return an empty list until the built-ins are registered. Only
		// mark the pass complete once we have actually wrapped something, so the
		// session_start retry below is not short-circuited.
		const candidates = pi.getAllTools().filter((info) => allowlist.includes(info.name));
		if (candidates.length === 0) return;
		for (const info of candidates) {
			pi.registerTool({
				name: info.name,
				label: info.name,
				description: info.description,
				parameters: info.parameters,
				approval: "read",
				async execute(_id, params, signal, onUpdate, ctx) {
					if (ctx.invokeTool === undefined) {
						throw new Error(`promiseflow: no native ${info.name} implementation to delegate to`);
					}
					const args = toRecord(params as unknown) ?? {};
					const key = stableHash([info.name, args]);
					const opts = {
					...(signal !== undefined ? { signal } : {}),
					...(onUpdate !== undefined ? { onUpdate } : {}),
				};
					const run = (): Promise<AgentToolResult<unknown>> => ctx.invokeTool!(args, opts);
					const shared = coordinator.getOrRun<AgentToolResult<unknown>>(key, run);
					// A follower's abort must not cancel the owner's execution.
					return await raceAbort(shared, signal);
				},
			});
			wrapped.push(info.name);
		}
		registered = true;
	};

	// Attempt at load (fast path); `getAllTools` may throw before the runtime is
	// initialized, so the `session_start` handler below retries regardless.
	try {
		registerWrappers();
	} catch {
		// retried on session_start
	}

	pi.on("session_start", async () => {
		registerWrappers();
		await coordinator.start();
	});

	pi.on("session_shutdown", async () => {
		await coordinator.close();
	});

	pi.registerTool({
		name: "pf_stats",
		label: "PromiseFlow Stats",
		description: "Single-flight coordination counters for wrapped read-only tools",
		parameters: pi.zod.object({}),
		approval: "read",
		async execute() {
			return {
				content: [{ type: "text", text: JSON.stringify(counters, null, 2) }],
				details: { ...counters, wrapped },
			} satisfies AgentToolResult;
		},
	});
}

function buildCoordinator(hooks: Hooks): PfCoordinator {
	const url = process.env.PF_REDIS_URL;
	if (url !== undefined && url !== "") {
		const backend = new RedisBackend(new Redis(url), { namespace: "omp-pf" });
		return new RedisCoordinator(backend, { hooks, staleAfter: 60, heartbeatInterval: 5 }) as PfCoordinator;
	}
	return new Coordinator({ hooks, retention: new Ephemeral(), staleAfter: 60, sweepInterval: 1 }) as PfCoordinator;
}

function readAllowlist(): string[] {
	const override = process.env.PF_COORDINATOR_TOOLS;
	if (override !== undefined) {
		return override
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	return ["read", "grep", "glob", "find", "web_search"];
}

/** Resolve `shared` unless `signal` aborts first; the owner keeps running. */
async function raceAbort<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined || !signal.aborted) return shared;
	if (signal.aborted) {
		shared.catch(() => {});
		throw new Error("promiseflow: follower aborted");
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new Error("promiseflow: follower aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		shared.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}