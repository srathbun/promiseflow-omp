import { expect, test } from "bun:test";
import Redis from "ioredis-mock";
import { Chain, RedisBackend, RedisCoordinator, Ttl } from "../index.ts";
import { nextRedisDb, sleep } from "./helpers.ts";

/**
 * End-to-end: RedisCoordinator over RedisBackend over shared ioredis-mock
 * instances. ioredis-mock isolates by `host:port/db`, so two clients with the
 * same `db` number share one logical store (analogous to two processes).
 */
function makeCoordinator(options: { retention?: Ttl } = {}): RedisCoordinator {
	const coordinatorOptions = { channel: "e2e", ...(options.retention !== undefined ? { retention: options.retention } : {}) };
	return new RedisCoordinator(new RedisBackend(new Redis({ db: nextRedisDb() }), { namespace: "e2e" }), coordinatorOptions);
}

/** Two coordinators over one shared in-process store (analogous to two processes). */
function makeCoordinatorPair(options: { retention?: Ttl } = {}): [RedisCoordinator, RedisCoordinator] {
	const db = nextRedisDb();
	const coordinatorOptions = { channel: "e2e", ...(options.retention !== undefined ? { retention: options.retention } : {}) };
	const mk = (): RedisCoordinator => new RedisCoordinator(new RedisBackend(new Redis({ db }), { namespace: "e2e" }), coordinatorOptions);
	return [mk(), mk()];
}

test("two processes share one owner end-to-end", async () => {
	let calls = 0;
	const work = async (): Promise<{ run: number }> => {
		calls += 1;
		await sleep(50);
		return { run: calls };
	};
	const [a, b] = makeCoordinatorPair();
	await a.start();
	await b.start();
	try {
		const results = await Promise.all([a.getOrRun("key", work), b.getOrRun("key", work)]);
		expect(results).toEqual([{ run: 1 }, { run: 1 }]);
	} finally {
		await a.close();
		await b.close();
	}
});

test("ephemeral rebuild end-to-end", async () => {
	let calls = 0;
	const work = async (): Promise<string> => `n=${(calls += 1)}`;
	const c = makeCoordinator();
	await c.start();
	try {
		expect(await c.getOrRun("key", work)).toBe("n=1");
		expect(await c.getOrRun("key", work)).toBe("n=2");
		expect(calls).toBe(2);
	} finally {
		await c.close();
	}
});

test("distributed chain end-to-end", async () => {
	let calls = 0;
	const step = async (val: number): Promise<number> => {
		calls += 1;
		await sleep(20);
		return val + 1;
	};
	const [a, b] = makeCoordinatorPair();
	await a.start();
	await b.start();
	try {
		const [ra, rb] = await Promise.all([new Chain(a).add("inc", step).run(0), new Chain(b).add("inc", step).run(0)]);
		expect(ra).toBe(1);
		expect(rb).toBe(1);
		expect(calls).toBe(1);
	} finally {
		await a.close();
		await b.close();
	}
});

test("ttl retention end-to-end", async () => {
	let calls = 0;
	const work = async (): Promise<string> => `v${(calls += 1)}`;
	const c = makeCoordinator({ retention: new Ttl(1) });
	await c.start();
	try {
		expect(await c.getOrRun("k", work)).toBe("v1");
		expect(await c.getOrRun("k", work)).toBe("v1");
	} finally {
		await c.close();
	}
	expect(calls).toBe(1);
});