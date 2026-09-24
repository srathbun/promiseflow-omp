import { expect, test } from "bun:test";
import { Coordinator, Hooks, RetryPolicy, Ttl } from "../index.ts";
import { sleep } from "./helpers.ts";

test("owner and success hooks fire", async () => {
	const events: Array<[string, string]> = [];
	const hooks = new Hooks({
		onOwner: (key) => {
			events.push(["owner", key]);
		},
		onSuccess: (key) => {
			events.push(["success", key]);
		},
	});
	const coordinator = new Coordinator({ hooks });
	await coordinator.start();
	try {
		await coordinator.getOrRun("k", async () => "ok");
	} finally {
		await coordinator.close();
	}
	expect(events).toContainEqual(["owner", "k"]);
	expect(events).toContainEqual(["success", "k"]);
});

test("follower hook fires once", async () => {
	const followers: string[] = [];
	const hooks = new Hooks({
		onFollower: (key) => {
			followers.push(key);
		},
	});
	const coordinator = new Coordinator({ hooks });
	await coordinator.start();
	try {
		const work = async (): Promise<string> => {
			await sleep(50);
			return "ok";
		};
		await Promise.all([coordinator.getOrRun("k", work), coordinator.getOrRun("k", work)]);
	} finally {
		await coordinator.close();
	}
	expect(followers).toEqual(["k"]);
});

test("cache hit hook fires on retained reuse", async () => {
	const hits: string[] = [];
	const hooks = new Hooks({
		onCacheHit: (key) => {
			hits.push(key);
		},
	});
	const coordinator = new Coordinator({ retention: new Ttl(1), hooks });
	await coordinator.start();
	try {
		await coordinator.getOrRun("k", async () => "ok");
		await coordinator.getOrRun("k", async () => "ok");
	} finally {
		await coordinator.close();
	}
	expect(hits).toEqual(["k"]);
});

test("error and retry hooks fire", async () => {
	const errors: string[] = [];
	const retries: number[] = [];
	const hooks = new Hooks({
		onError: (key) => {
			errors.push(key);
		},
		onRetry: (_, attempt) => {
			retries.push(attempt);
		},
	});
	const coordinator = new Coordinator({ hooks });
	await coordinator.start();
	let calls = 0;
	try {
		const flaky = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return "ok";
		};
		await coordinator.getOrRun("k", flaky, { retry: new RetryPolicy({ maxAttempts: 2 }) });
	} finally {
		await coordinator.close();
	}
	expect(errors).toEqual(["k"]);
	expect(retries).toEqual([2]);
});