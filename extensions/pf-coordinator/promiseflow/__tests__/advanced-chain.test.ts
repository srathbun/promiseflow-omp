import { expect, test } from "bun:test";
import { AdvancedChain, CachePointMode, Coordinator, createCachePointsOnlyChain, createFullChain } from "../index.ts";
import { sleep } from "./helpers.ts";

async function withCoordinator<T>(fn: (c: Coordinator) => Promise<T>): Promise<T> {
	const coordinator = new Coordinator({ staleAfter: 60, sweepInterval: 0.1 });
	await coordinator.start();
	try {
		return await fn(coordinator);
	} finally {
		await coordinator.close();
	}
}

test("cache point retained across waves, non-cache step recomputes", async () => {
	await withCoordinator(async (coordinator) => {
		const counts: Record<string, number> = {};
		const cached = async (v: number): Promise<number> => {
			counts.cached = (counts.cached ?? 0) + 1;
			await sleep(10);
			return v + 1;
		};
		const ephemeral = async (v: number): Promise<number> => {
			counts.ephemeral = (counts.ephemeral ?? 0) + 1;
			await sleep(10);
			return v * 2;
		};
		const chain = new AdvancedChain(coordinator, { cachePointMode: CachePointMode.CACHE_POINTS_ONLY });
		chain.add("cached", cached, { isCachePoint: true }).add("ephemeral", ephemeral);
		await chain.run(10);
		await chain.run(10);

		expect(counts.cached).toBe(1);
		expect(counts.ephemeral).toBe(2);
	});
});

test("single flight within a wave (AdvancedChain)", async () => {
	await withCoordinator(async (coordinator) => {
		const counts: Record<string, number> = {};
		const work = async (v: number): Promise<number> => {
			counts.work = (counts.work ?? 0) + 1;
			await sleep(20);
			return v + 1;
		};
		const chain = new AdvancedChain(coordinator).add("work", work);
		const results = await Promise.all(Array.from({ length: 10 }, () => chain.run(1)));
		expect(results.every((r) => r === 2)).toBe(true);
		expect(counts.work).toBe(1);
	});
});

test("cascade recompute only when upstream value changes", async () => {
	await withCoordinator(async (coordinator) => {
		const counts: Record<string, number> = {};
		const upstream = async (v: string): Promise<string> => {
			counts.upstream = (counts.upstream ?? 0) + 1;
			await sleep(10);
			return v.toUpperCase();
		};
		const downstream = async (v: string): Promise<number> => {
			counts.downstream = (counts.downstream ?? 0) + 1;
			await sleep(10);
			return v.length;
		};
		const chain = new AdvancedChain(coordinator, { cachePointMode: CachePointMode.FULL_CHAIN });
		chain.add("upstream", upstream).add("downstream", downstream);
		await chain.run("abc");
		await chain.run("abc"); // unchanged → downstream reused
		await chain.run("different"); // changed → cascade

		expect(counts.upstream).toBe(2);
		expect(counts.downstream).toBe(2);
	});
});

test("uncached tail recomputes across waves", async () => {
	await withCoordinator(async (coordinator) => {
		const counts: Record<string, number> = {};
		const prefix = async (v: number): Promise<number> => {
			counts.prefix = (counts.prefix ?? 0) + 1;
			await sleep(10);
			return v + 1;
		};
		const tail = async (v: number): Promise<number> => {
			counts.tail = (counts.tail ?? 0) + 1;
			await sleep(10);
			return v * 2;
		};
		const chain = new AdvancedChain(coordinator, { cachePointMode: CachePointMode.FULL_CHAIN });
		chain.add("prefix", prefix).add("tail", tail, { uncachedTail: true });
		await chain.run(1);
		await chain.run(1);

		expect(counts.prefix).toBe(1);
		expect(counts.tail).toBe(2);
	});
});

test("factories select the right cache point mode", async () => {
	await withCoordinator(async (coordinator) => {
		expect(createCachePointsOnlyChain(coordinator).cachePointMode).toBe(CachePointMode.CACHE_POINTS_ONLY);
		expect(createFullChain(coordinator).cachePointMode).toBe(CachePointMode.FULL_CHAIN);
	});
});

test("cache status reports configuration", () => {
	const step = async (v: number): Promise<number> => v;
	const coordinator = new Coordinator();
	const chain = new AdvancedChain(coordinator, { cachePointMode: CachePointMode.CACHE_POINTS_ONLY });
	chain.add("a", step, { isCachePoint: true }).add("b", step).add("c", step, { uncachedTail: true });
	const status = chain.cacheStatus();
	expect(status.totalSteps).toBe(3);
	expect(status.cachePoints).toBe(1);
	expect(status.uncachedTailSteps).toBe(1);
	expect(status.cachePointMode).toBe("cache_points_only");
});