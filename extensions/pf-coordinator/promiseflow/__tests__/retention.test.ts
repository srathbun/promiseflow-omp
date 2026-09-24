import { expect, test } from "bun:test";
import { Coordinator, Ephemeral, Manual, StaleWhileRevalidate, Ttl } from "../index.ts";
import { sleep, until } from "./helpers.ts";

test("ttl reuses within lifetime", async () => {
	const coordinator = new Coordinator({ retention: new Ttl(1) });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		const first = await coordinator.getOrRun("k", work);
		const second = await coordinator.getOrRun("k", work);
		expect(first).toBe("v1");
		expect(second).toBe("v1");
		expect(calls).toBe(1);
	} finally {
		await coordinator.close();
	}
});

test("ttl expires then rebuilds", async () => {
	const coordinator = new Coordinator({ retention: new Ttl(0.05) });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		const first = await coordinator.getOrRun("k", work);
		await sleep(80);
		const second = await coordinator.getOrRun("k", work);
		expect(first).toBe("v1");
		expect(second).toBe("v2");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("manual reuses until invalidated", async () => {
	const coordinator = new Coordinator({ retention: new Manual() });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		expect(await coordinator.getOrRun("k", work)).toBe("v1");
		expect(await coordinator.getOrRun("k", work)).toBe("v1");
		expect(calls).toBe(1);

		coordinator.invalidate("k");
		expect(await coordinator.getOrRun("k", work)).toBe("v2");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("clear drops all retained results", async () => {
	const coordinator = new Coordinator({ retention: new Manual() });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		expect(await coordinator.getOrRun("a", work)).toBe("v1");
		expect(await coordinator.getOrRun("b", work)).toBe("v2");
		coordinator.clear();
		expect(await coordinator.getOrRun("a", work)).toBe("v3");
		expect(await coordinator.getOrRun("b", work)).toBe("v4");
		expect(calls).toBe(4);
	} finally {
		await coordinator.close();
	}
});

test("stale-while-revalidate serves stale then refreshes", async () => {
	const coordinator = new Coordinator({ retention: new StaleWhileRevalidate(0.2) });
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		expect(await coordinator.getOrRun("k", work)).toBe("v1");

		await sleep(300); // expire

		const stale = await coordinator.getOrRun("k", work);
		expect(stale).toBe("v1"); // served stale immediately

		await until(() => calls === 2);
		await sleep(20);

		const fresh = await coordinator.getOrRun("k", work);
		expect(fresh).toBe("v2");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("ephemeral is the default and reruns", async () => {
	const coordinator = new Coordinator();
	await coordinator.start();
	let calls = 0;
	try {
		const work = async (): Promise<string> => `v${(calls += 1)}`;
		expect(await coordinator.getOrRun("k", work)).toBe("v1");
		expect(await coordinator.getOrRun("k", work)).toBe("v2");
		expect(calls).toBe(2);
	} finally {
		await coordinator.close();
	}
});

test("retention validation and flags", () => {
	expect(() => new Ttl(0)).toThrow(RangeError);
	expect(() => new StaleWhileRevalidate(-1)).toThrow(RangeError);
	expect(new Ephemeral().retain).toBe(false);
	expect(new Manual().retain).toBe(true);
	expect(new Ephemeral().staleWhileRevalidate).toBe(false);
	expect(new StaleWhileRevalidate(1).staleWhileRevalidate).toBe(true);
});