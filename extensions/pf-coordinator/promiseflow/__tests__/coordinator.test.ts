import { expect, test } from "bun:test";
import { Coordinator, RetryPolicy, WorkTimeoutError } from "../index.ts";
import { sleep } from "./helpers.ts";

test("deduplicates parallel requests", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => {
			calls += 1;
			await sleep(50);
			return "ok";
		};
		const results = await Promise.all(Array.from({ length: 20 }, () => coordinator.getOrRun("same-key", work)));
		expect(results.every((r) => r === "ok")).toBe(true);
		expect(calls).toBe(1);
	} finally {
		await coordinator.close();
	}
});

test("retries then succeeds", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const flaky = async (): Promise<string> => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return "ok";
		};
		const result = await coordinator.getOrRun("retry-key", flaky, {
			retry: new RetryPolicy({ maxAttempts: 4, baseDelay: 0.01 }),
		});
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	} finally {
		await coordinator.close();
	}
});

test("timeout raises WorkTimeoutError", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	try {
		const slow = async (): Promise<string> => {
			await sleep(200);
			return "late";
		};
		await expect(coordinator.getOrRun("slow-key", slow, { timeout: 0.01 })).rejects.toBeInstanceOf(WorkTimeoutError);
	} finally {
		await coordinator.close();
	}
});

test("stale worker is rejected and retried by follower", async () => {
	const coordinator = new Coordinator({ staleAfter: 0.05, sweepInterval: 0.01 });
	await coordinator.start();
	try {
		let started = false;
		const hangs = async (): Promise<string> => {
			started = true;
			await sleep(10_000);
			return "never";
		};
		const owner = coordinator.getOrRun("stale-key", hangs, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
			heartbeatInterval: 0.2,
		});
		while (!started) await sleep(1);
		await sleep(80);

		const recovery = async (): Promise<string> => "recovered";
		const follower = await coordinator.getOrRun("stale-key", recovery, {
			retry: new RetryPolicy({ maxAttempts: 2, baseDelay: 0.01 }),
		});
		expect(follower).toBe("recovered");
		// The stalled owner keeps hanging; don't await it (its result is unobserved).
		owner.catch(() => {});
	} finally {
		await coordinator.close();
	}
});

test("cancelled waiter does not disturb the owner", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	try {
		let started = false;
		const slow = async (): Promise<string> => {
			started = true;
			await sleep(200);
			return "ok";
		};
		// Follower that never completes is not observed; owner finishes on its own.
		const result = coordinator.getOrRun("cancel-key", slow);
		while (!started) await sleep(1);
		expect(await coordinator.getOrRun("cancel-key", slow)).toBe("ok");
		expect(await result).toBe("ok");
	} finally {
		await coordinator.close();
	}
});

test("waiters retry after owner failure", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const flaky = async (): Promise<string> => {
			calls += 1;
			await sleep(20); // give other callers time to join as waiters
			if (calls === 1) throw new Error("transient owner failure");
			return "success";
		};
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				coordinator.getOrRun("flaky-owner-key", flaky, { retry: new RetryPolicy({ maxAttempts: 3, baseDelay: 0.01 }) }),
			),
		);
		expect(results.every((r) => r === "success")).toBe(true);
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});