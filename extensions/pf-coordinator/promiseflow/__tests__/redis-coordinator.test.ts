import { expect, test } from "bun:test";
import { Chain, Manual, RedisCoordinator, RetryExhaustedError, RetryPolicy, StaleWhileRevalidate, Ttl, WorkTimeoutError } from "../index.ts";
import { FakeBackend } from "./_fake-backend.ts";
import { sleep, until } from "./helpers.ts";

type AnyCoordinator = RedisCoordinator<unknown>;

function makeCoordinator(backend: FakeBackend, options: Record<string, unknown> = {}): AnyCoordinator {
	return new RedisCoordinator(backend, { channel: "test", ...options });
}

test("two coordinators share one owner", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<string> => {
		calls += 1;
		await sleep(50);
		return "ok";
	};
	const a = makeCoordinator(backend);
	const b = makeCoordinator(backend);
	await a.start();
	await b.start();
	try {
		const results = await Promise.all([a.getOrRun("k", work), b.getOrRun("k", work)]);
		expect(results).toEqual(["ok", "ok"]);
		expect(calls).toBe(1);
	} finally {
		await a.close();
		await b.close();
	}
});

test("many followers share one result", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<{ n: number }> => {
		calls += 1;
		await sleep(20);
		return { n: calls };
	};
	const a = makeCoordinator(backend);
	const b = makeCoordinator(backend);
	await a.start();
	await b.start();
	try {
		const results = await Promise.all([...Array.from({ length: 5 }, () => a.getOrRun("k", work)), ...Array.from({ length: 5 }, () => b.getOrRun("k", work))]);
		expect(results.every((r) => r.n === 1)).toBe(true);
		expect(calls).toBe(1);
	} finally {
		await a.close();
		await b.close();
	}
});

test("ephemeral next call reruns", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<string> => `run-${(calls += 1)}`;
	const c = makeCoordinator(backend);
	await c.start();
	try {
		expect(await c.getOrRun("k", work)).toBe("run-1");
		expect(await c.getOrRun("k", work)).toBe("run-2");
		expect(calls).toBe(2);
	} finally {
		await c.close();
	}
});

test("stale owner reclaimed via lock expiry", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const slow = async (label: string): Promise<string> => {
		calls += 1;
		await sleep(100);
		return label;
	};
	const a = new RedisCoordinator(backend, { channel: "test", staleAfter: 0.03, heartbeatInterval: 10 });
	const b = new RedisCoordinator(backend, { channel: "test", staleAfter: 0.03, heartbeatInterval: 10 });
	await a.start();
	await b.start();
	try {
		const taskA = a.getOrRun("k", () => slow("A"));
		await sleep(60); // let a's lock expire before b claims
		const resultB = await b.getOrRun("k", () => slow("B"));
		const resultA = await taskA;
		expect(calls).toBe(2);
		expect(resultA).toBe("A");
		expect(resultB).toBe("B");
	} finally {
		await a.close();
		await b.close();
	}
});

test("owner failure retries to success", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const flaky = async (): Promise<string> => {
		calls += 1;
		if (calls === 1) throw new Error("boom");
		return "recovered";
	};
	const c = makeCoordinator(backend);
	await c.start();
	try {
		expect(await c.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 2 }) })).toBe("recovered");
		expect(calls).toBe(2);
	} finally {
		await c.close();
	}
});

test("follower retries after owner failure", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const gate = Promise.withResolvers<void>();
	const flaky = async (): Promise<string> => {
		calls += 1;
		if (calls === 1) {
			await gate.promise;
			throw new Error("owner failed");
		}
		await sleep(20);
		return "ok";
	};
	const a = makeCoordinator(backend);
	const b = makeCoordinator(backend);
	await a.start();
	await b.start();
	try {
		const taskA = a.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 1 }) });
		await sleep(20);
		const taskB = b.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 3 }) });
		await sleep(20);
		gate.resolve();
		await expect(taskA).rejects.toBeInstanceOf(RetryExhaustedError);
		expect(await taskB).toBe("ok");
		expect(calls).toBe(2);
	} finally {
		await a.close();
		await b.close();
	}
});

test("owner exception raises retry exhausted with cause", async () => {
	const backend = new FakeBackend();
	const boom = async (): Promise<string> => {
		throw new Error("nope");
	};
	const c = makeCoordinator(backend);
	await c.start();
	try {
		await expect(c.getOrRun("k", boom, { retry: new RetryPolicy({ maxAttempts: 1 }) })).rejects.toBeInstanceOf(RetryExhaustedError);
	} finally {
		await c.close();
	}
});

test("work timeout raises WorkTimeoutError", async () => {
	const backend = new FakeBackend();
	const slow = async (): Promise<string> => {
		await sleep(500);
		return "late";
	};
	const c = makeCoordinator(backend);
	await c.start();
	try {
		await expect(
			c.getOrRun("k", slow, { timeout: 0.02, retry: new RetryPolicy({ maxAttempts: 1 }) }),
		).rejects.toBeInstanceOf(WorkTimeoutError);
	} finally {
		await c.close();
	}
});

test("distributed chain shares segments", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const step = async (val: number): Promise<number> => {
		calls += 1;
		await sleep(20);
		return val + 1;
	};
	const a = makeCoordinator(backend);
	const b = makeCoordinator(backend);
	await a.start();
	await b.start();
	try {
		const chainA = new Chain(a).add("inc", step);
		const chainB = new Chain(b).add("inc", step);
		const [ra, rb] = await Promise.all([chainA.run(0), chainB.run(0)]);
		expect(ra).toBe(1);
		expect(rb).toBe(1);
		expect(calls).toBe(1);
	} finally {
		await a.close();
		await b.close();
	}
});

test("ttl retention reuses across coordinators", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<string> => `v${(calls += 1)}`;
	const a = makeCoordinator(backend, { retention: new Ttl(1) });
	const b = makeCoordinator(backend, { retention: new Ttl(1) });
	await a.start();
	await b.start();
	try {
		expect(await a.getOrRun("k", work)).toBe("v1");
		expect(await b.getOrRun("k", work)).toBe("v1");
	} finally {
		await a.close();
		await b.close();
	}
	expect(calls).toBe(1);
});

test("manual retention invalidate by key", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<string> => `v${(calls += 1)}`;
	const c = makeCoordinator(backend, { retention: new Manual() });
	await c.start();
	try {
		expect(await c.getOrRun("k", work)).toBe("v1");
		expect(await c.getOrRun("k", work)).toBe("v1");
		await c.invalidate("k");
		expect(await c.getOrRun("k", work)).toBe("v2");
	} finally {
		await c.close();
	}
	expect(calls).toBe(2);
});

test("stale-while-revalidate serves stale then refreshes", async () => {
	const backend = new FakeBackend();
	let calls = 0;
	const work = async (): Promise<string> => `v${(calls += 1)}`;
	const c = makeCoordinator(backend, { retention: new StaleWhileRevalidate(0.2) });
	await c.start();
	try {
		expect(await c.getOrRun("k", work)).toBe("v1");
		await sleep(300); // expire
		expect(await c.getOrRun("k", work)).toBe("v1"); // stale served
		await until(() => calls === 2);
		await sleep(20);
		expect(await c.getOrRun("k", work)).toBe("v2");
		expect(calls).toBe(2);
	} finally {
		await c.close();
	}
});