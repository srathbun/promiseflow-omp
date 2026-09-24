import { expect, test } from "bun:test";
import Redis from "ioredis-mock";
import { JsonCodec, RedisBackend } from "../index.ts";
import { nextRedisDb } from "./helpers.ts";

function makeBackend(namespace = "test"): RedisBackend {
	// A fresh `db` number per test gives each test an isolated ioredis-mock store.
	return new RedisBackend(new Redis({ db: nextRedisDb() }), { namespace });
}

test("acquire returns false when held", async () => {
	const backend = makeBackend();
	expect(await backend.acquire("k", "a", 10)).toBe(true);
	expect(await backend.acquire("k", "b", 10)).toBe(false);
});

test("owner returns token", async () => {
	const backend = makeBackend();
	expect(await backend.owner("k")).toBeNull();
	await backend.acquire("k", "a", 10);
	expect(await backend.owner("k")).toBe("a");
});

test("renew is token-guarded", async () => {
	const backend = makeBackend();
	await backend.acquire("k", "a", 10);
	expect(await backend.renew("k", "wrong", 10)).toBe(false);
	expect(await backend.renew("k", "a", 10)).toBe(true);
});

test("release is token-guarded", async () => {
	const backend = makeBackend();
	await backend.acquire("k", "a", 10);
	await backend.release("k", "wrong");
	expect(await backend.owner("k")).toBe("a");
	await backend.release("k", "a");
	expect(await backend.owner("k")).toBeNull();
});

test("payload round-trips through the codec and take is non-destructive", async () => {
	const backend = makeBackend();
	const value = { nested: [1, 2, { x: "y" }] };
	await backend.put("k", "tok", value);
	expect(await backend.take("k", "tok")).toEqual(value);
	expect(await backend.take("k", "tok")).toEqual(value);
	await backend.discard("k", "tok");
	expect(await backend.take("k", "tok")).toBeNull();
});

test("publish/subscribe delivers via duplicate connection", async () => {
	const backend = makeBackend();
	await backend.publish("ch", "warmup");
	const subscription = backend.subscribe("ch");
	const received: Promise<string> = subscription.next().then((r) => r.value as string);
	// The underlying SUBSCRIBE is asynchronous; publish after a tick.
	await new Promise((resolve) => setTimeout(resolve, 5));
	await backend.publish("ch", "payload");
	expect(await received).toBe("payload");
	await subscription.return?.();
});

test("keys are namespaced", async () => {
	const client = new Redis({ db: nextRedisDb() });
	const a = new RedisBackend(client, { namespace: "app-a" });
	const b = new RedisBackend(client, { namespace: "app-b" });
	await a.acquire("k", "tok", 10);
	expect(await b.owner("k")).toBeNull();
});

test("result store get/set/delete/clear round-trips", async () => {
	const backend = makeBackend();
	expect(await backend.resultGet("k")).toBeNull();
	await backend.resultSet("k", ["value", 123], 1000);
	expect(await backend.resultGet("k")).toEqual(["value", 123]);
	await backend.resultDelete("k");
	expect(await backend.resultGet("k")).toBeNull();
	await backend.resultSet("x", 1);
	await backend.resultSet("y", 2);
	await backend.resultClear();
	expect(await backend.resultGet("x")).toBeNull();
	expect(await backend.resultGet("y")).toBeNull();
});

test("JsonCodec round-trips JSON-safe values", () => {
	const codec = new JsonCodec();
	expect(codec.loads(codec.dumps({ a: [1, 2, 3] }))).toEqual({ a: [1, 2, 3] });
});