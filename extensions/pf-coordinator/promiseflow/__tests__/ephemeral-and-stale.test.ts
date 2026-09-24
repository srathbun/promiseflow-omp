import { expect, test } from "bun:test";
import { Coordinator, RetryExhaustedError, RetryPolicy } from "../index.ts";
import { sleep } from "./helpers.ts";

test("sequential same key reruns work (ephemeral)", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `ok-${(calls += 1)}`;
		expect(await coordinator.getOrRun("k", work)).toBe("ok-1");
		expect(await coordinator.getOrRun("k", work)).toBe("ok-2");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("failed entry is also ephemeral", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const flaky = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return "recovered";
		};
		await expect(coordinator.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 1 }) })).rejects.toBeInstanceOf(
			RetryExhaustedError,
		);
		expect(await coordinator.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 1 }) })).toBe("recovered");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("stale worker reclaimed around stale_after", async () => {
	const coordinator = new Coordinator({ staleAfter: 0.1, sweepInterval: 0.01 });
	await coordinator.start();
	try {
		const gate = Promise.withResolvers<void>();
		const stall = async (): Promise<void> => gate.promise;
		const owner = coordinator.getOrRun("timing-key", stall, { heartbeatInterval: 0.2 });
		await sleep(5);
		const start = performance.now();
		const recover = async (): Promise<string> => "recovered";
		const result = await coordinator.getOrRun("timing-key", recover, { retry: new RetryPolicy({ maxAttempts: 2, baseDelay: 0.01 }) });
		const elapsed = (performance.now() - start) / 1000;
		expect(result).toBe("recovered");
		expect(elapsed).toBeGreaterThanOrEqual(0.1);
		expect(elapsed).toBeLessThan(0.5);
		gate.resolve();
		owner.catch(() => {});
	} finally {
		await coordinator.close();
	}
});

test("late stale worker resolution is a no-op after handover", async () => {
	const coordinator = new Coordinator({ staleAfter: 0.05, sweepInterval: 0.01 });
	await coordinator.start();
	try {
		const gate = Promise.withResolvers<void>();
		const hangsThenSucceeds = async (): Promise<string> => {
			await gate.promise;
			return "late-stale";
		};
		const owner = coordinator.getOrRun("late-key", hangsThenSucceeds, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
			heartbeatInterval: 0.2,
		});
		await sleep(80); // let the sweeper reclaim the owner
		const recovery = async (): Promise<string> => "recovered";
		expect(await coordinator.getOrRun("late-key", recovery, { retry: new RetryPolicy({ maxAttempts: 2, baseDelay: 0.01 }) })).toBe("recovered");
		gate.resolve();
		expect(await owner).toBe("late-stale");
	} finally {
		await coordinator.close();
	}
});

test("late stale worker rejection is a no-op after handover", async () => {
	const coordinator = new Coordinator({ staleAfter: 0.05, sweepInterval: 0.01 });
	await coordinator.start();
	try {
		const gate = Promise.withResolvers<void>();
		const hangsThenFails = async (): Promise<string> => {
			await gate.promise;
			throw new Error("late-failure");
		};
		const owner = coordinator.getOrRun("late-fail-key", hangsThenFails, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
			heartbeatInterval: 0.2,
		});
		await sleep(80);
		const recovery = async (): Promise<string> => "recovered";
		expect(await coordinator.getOrRun("late-fail-key", recovery, { retry: new RetryPolicy({ maxAttempts: 2, baseDelay: 0.01 }) })).toBe("recovered");
		gate.resolve();
		await expect(owner).rejects.toBeInstanceOf(RetryExhaustedError);
	} finally {
		await coordinator.close();
	}
});

test("high concurrency stays correct", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	try {
		const work = async (): Promise<string> => {
			await sleep(10);
			return "ok";
		};
		const results = await Promise.all(Array.from({ length: 50 }, () => coordinator.getOrRun("k", work)));
		expect(results.every((r) => r === "ok")).toBe(true);
	} finally {
		await coordinator.close();
	}
});