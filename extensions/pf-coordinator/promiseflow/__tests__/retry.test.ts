import { expect, test } from "bun:test";
import { Coordinator, RetryExhaustedError, RetryPolicy } from "../index.ts";

test("retry exhaustion raises RetryExhaustedError after maxAttempts", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	let calls = 0;
	try {
		const failing = async (): Promise<string> => {
			calls += 1;
			throw new Error("permanent failure");
		};
		await expect(
			coordinator.getOrRun("exhaustion-key", failing, { retry: new RetryPolicy({ maxAttempts: 3, baseDelay: 0.01 }) }),
		).rejects.toBeInstanceOf(RetryExhaustedError);
		expect(calls).toBe(3);
	} finally {
		await coordinator.close();
	}
});

test("retry exhaustion carries the last error as cause", async () => {
	const coordinator = new Coordinator({ staleAfter: 5, sweepInterval: 0.2 });
	await coordinator.start();
	try {
		const failing = async (): Promise<string> => {
			throw new Error("boom-cause");
		};
		try {
			await coordinator.getOrRun("k", failing, { retry: new RetryPolicy({ maxAttempts: 1 }) });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RetryExhaustedError);
			if (error instanceof RetryExhaustedError) {
				expect(error.cause).toBeInstanceOf(Error);
				expect((error.cause as Error).message).toBe("boom-cause");
			}
		}
	} finally {
		await coordinator.close();
	}
});

test("retry policy rejects non-positive maxAttempts", () => {
	expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
	expect(() => new RetryPolicy({ maxAttempts: -1 })).toThrow(RangeError);
});

test("retry backoff grows and caps", () => {
	const policy = new RetryPolicy({ baseDelay: 0.1, maxDelay: 0.25, multiplier: 2 });
	expect(policy.delayForAttempt(1)).toBe(0);
	expect(policy.delayForAttempt(2)).toBeCloseTo(0.1);
	expect(policy.delayForAttempt(3)).toBeCloseTo(0.2);
	expect(policy.delayForAttempt(4)).toBeCloseTo(0.25); // capped
});