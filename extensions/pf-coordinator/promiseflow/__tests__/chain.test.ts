import { expect, test } from "bun:test";
import { Chain, Coordinator, RetryExhaustedError, RetryPolicy } from "../index.ts";
import { sleep } from "./helpers.ts";

async function withCoordinator<T>(fn: (c: Coordinator) => Promise<T>): Promise<T> {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	try {
		return await fn(coordinator);
	} finally {
		await coordinator.close();
	}
}

test("chain deduplicates shared segments", async () => {
	await withCoordinator(async (coordinator) => {
		let callsA = 0;
		let callsB = 0;
		const stepA = async (val: number): Promise<number> => {
			callsA += 1;
			await sleep(50);
			return val + 1;
		};
		const stepB = async (val: number): Promise<number> => {
			callsB += 1;
			await sleep(50);
			return val * 2;
		};
		const runChain = (): Promise<number> => new Chain(coordinator).add("step_a", stepA).add("step_b", stepB).run(10);
		const results = await Promise.all(Array.from({ length: 5 }, runChain));
		expect(results.every((r) => r === 22)).toBe(true);
		expect(callsA).toBe(1);
		expect(callsB).toBe(1);
	});
});

test("chain partial overlap shares prefix only", async () => {
	await withCoordinator(async (coordinator) => {
		let shared = 0;
		let branch1 = 0;
		let branch2 = 0;
		const sharedStep = async (val: number): Promise<number> => {
			shared += 1;
			await sleep(50);
			return val + 5;
		};
		const branch1Step = async (val: number): Promise<number> => {
			branch1 += 1;
			await sleep(50);
			return val * 10;
		};
		const branch2Step = async (val: number): Promise<number> => {
			branch2 += 1;
			await sleep(50);
			return val + 100;
		};
		const b1 = (): Promise<number> => new Chain(coordinator).add("shared", sharedStep).add("b1", branch1Step).run(0);
		const b2 = (): Promise<number> => new Chain(coordinator).add("shared", sharedStep).add("b2", branch2Step).run(0);
		const [r1, r2, r3, r4] = await Promise.all([b1(), b1(), b2(), b2()]);
		expect([r1, r2, r3, r4]).toEqual([50, 50, 105, 105]);
		expect(shared).toBe(1);
		expect(branch1).toBe(1);
		expect(branch2).toBe(1);
	});
});

test("chain error surfaces as RetryExhaustedError wrapping the cause", async () => {
	await withCoordinator(async (coordinator) => {
		const badStep = async (): Promise<number> => {
			throw new Error("bad step");
		};
		const chain = new Chain(coordinator).add("bad", badStep);
		try {
			await chain.run();
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RetryExhaustedError);
			if (error instanceof RetryExhaustedError) {
				expect(error.cause).toBeInstanceOf(Error);
				expect((error.cause as Error).message).toBe("bad step");
			}
		}
	});
});

test("chain different initial values are not shared", async () => {
	await withCoordinator(async (coordinator) => {
		let calls = 0;
		const step = async (val: number): Promise<number> => {
			calls += 1;
			await sleep(50);
			return val + 1;
		};
		const [ra, rb] = await Promise.all([
			new Chain(coordinator).add("step", step).run(10),
			new Chain(coordinator).add("step", step).run(20),
		]);
		expect(ra).toBe(11);
		expect(rb).toBe(21);
		expect(calls).toBe(2);
	});
});

test("chain three-deep shared prefix", async () => {
	await withCoordinator(async (coordinator) => {
		let queryCalls = 0;
		let sortCalls = 0;
		let groupCalls = 0;
		let limitCalls = 0;
		const query = async (): Promise<Array<{ x: number }>> => {
			queryCalls += 1;
			await sleep(50);
			return [{ x: 1 }, { x: 2 }, { x: 3 }];
		};
		const sortStep = async (rows: Array<{ x: number }>): Promise<Array<{ x: number }>> => {
			sortCalls += 1;
			await sleep(50);
			return [...rows].sort((a, b) => a.x - b.x);
		};
		const groupStep = async (rows: Array<{ x: number }>): Promise<{ count: number }> => {
			groupCalls += 1;
			return { count: rows.length };
		};
		const limitStep = async (rows: Array<{ x: number }>): Promise<Array<{ x: number }>> => {
			limitCalls += 1;
			return rows.slice(0, 2);
		};
		const a = (): Promise<unknown> => new Chain(coordinator).add("query", query).add("sort", sortStep).add("group", groupStep).run();
		const b = (): Promise<unknown> => new Chain(coordinator).add("query", query).add("sort", sortStep).add("limit", limitStep).run();
		const [aResult, bResult] = await Promise.all([a(), b()]);
		expect(aResult).toEqual({ count: 3 });
		expect(bResult).toEqual([{ x: 1 }, { x: 2 }]);
		expect(queryCalls).toBe(1);
		expect(sortCalls).toBe(1);
		expect(groupCalls).toBe(1);
		expect(limitCalls).toBe(1);
	});
});

test("chain with custom retry", async () => {
	await withCoordinator(async (coordinator) => {
		let calls = 0;
		const flaky = async (val: number): Promise<number> => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return val + 1;
		};
		const result = await new Chain(coordinator).add("flaky", flaky).run(0, { retry: new RetryPolicy({ maxAttempts: 5, baseDelay: 0.01 }) });
		expect(result).toBe(1);
		expect(calls).toBe(3);
	});
});

test("distinct callables with the same name do not alias", async () => {
	await withCoordinator(async (coordinator) => {
		let callsA = 0;
		let callsB = 0;
		const stepA = async (val: number): Promise<number> => {
			callsA += 1;
			await sleep(20);
			return val + 10;
		};
		const stepB = async (val: number): Promise<number> => {
			callsB += 1;
			await sleep(20);
			return val + 100;
		};
		const [ra, rb] = await Promise.all([
			new Chain(coordinator).add("shared", stepA).run(0),
			new Chain(coordinator).add("shared", stepB).run(0),
		]);
		expect(ra).toBe(10);
		expect(rb).toBe(100);
		expect(callsA).toBe(1);
		expect(callsB).toBe(1);
	});
});

test("same callable shares across chains", async () => {
	await withCoordinator(async (coordinator) => {
		let calls = 0;
		const step = async (val: number): Promise<number> => {
			calls += 1;
			await sleep(20);
			return val + 1;
		};
		const results = await Promise.all(Array.from({ length: 5 }, () => new Chain(coordinator).add("inc", step).run(0)));
		expect(results).toEqual([1, 1, 1, 1, 1]);
		expect(calls).toBe(1);
	});
});

test("distinct step names do not share", async () => {
	await withCoordinator(async (coordinator) => {
		let callsA = 0;
		let callsB = 0;
		const stepA = async (val: number): Promise<number> => {
			callsA += 1;
			await sleep(20);
			return val + 10;
		};
		const stepB = async (val: number): Promise<number> => {
			callsB += 1;
			await sleep(20);
			return val + 100;
		};
		const [ra, rb] = await Promise.all([
			new Chain(coordinator).add("a", stepA).run(0),
			new Chain(coordinator).add("b", stepB).run(0),
		]);
		expect(ra).toBe(10);
		expect(rb).toBe(100);
		expect(callsA).toBe(1);
		expect(callsB).toBe(1);
	});
});

test("chain segments recompute on sequential runs (ephemeral)", async () => {
	await withCoordinator(async (coordinator) => {
		let calls = 0;
		const step = async (val: number): Promise<number> => {
			calls += 1;
			return val + 1;
		};
		const chain = new Chain(coordinator).add("inc", step);
		expect(await chain.run<number>(0)).toBe(1);
		expect(await chain.run<number>(0)).toBe(1);
		expect(calls).toBe(2);
	});
});