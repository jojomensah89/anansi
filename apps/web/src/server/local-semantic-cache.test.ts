import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalSemanticCache } from "./local-semantic-cache.ts";

function withCache(run: (path: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "anansi-semantic-cache-test-"));
	const path = join(directory, "semantic.sqlite");
	return run(path).finally(() =>
		rmSync(directory, { recursive: true, force: true }),
	);
}

describe("local semantic cache", () => {
	test("persists vectors and ranks cosine similarity deterministically", () =>
		withCache(async (path) => {
			const first = openLocalSemanticCache(path, "embeddinggemma");
			await first.upsertRecords([
				{ id: "b", contentHash: "b1", values: [1, 0] },
				{ id: "a", contentHash: "a1", values: [1, 0] },
				{ id: "c", contentHash: "c1", values: [0, 1] },
			]);
			expect(await first.query([1, 0], { topK: 2 })).toEqual([
				{ id: "a", score: 1 },
				{ id: "b", score: 1 },
			]);
			first.close();

			const reopened = openLocalSemanticCache(path, "embeddinggemma");
			expect(reopened.snapshot().indexed).toBe(3);
			expect(await reopened.query([1, 0], { topK: 2 })).toEqual([
				{ id: "a", score: 1 },
				{ id: "b", score: 1 },
			]);
			reopened.close();
		}));

	test("replaces, invalidates, and isolates model generations", () =>
		withCache(async (path) => {
			const cache = openLocalSemanticCache(path, "embeddinggemma");
			await cache.upsertRecords([
				{ id: "item", contentHash: "one", values: [1, 0] },
			]);
			await cache.upsertRecords([
				{ id: "item", contentHash: "two", values: [0, 1] },
			]);
			expect(await cache.query([0, 1])).toEqual([{ id: "item", score: 1 }]);
			cache.replaceGeneration("nomic-embed-text");
			expect(cache.snapshot().indexed).toBe(0);
			await cache.upsertRecords([
				{ id: "new", contentHash: "new", values: [1, 0] },
			]);
			await cache.invalidate(["new"]);
			expect(await cache.query([1, 0])).toEqual([]);
			cache.close();
		}));

	test("rejects malformed and mismatched vectors", () =>
		withCache(async (path) => {
			const cache = openLocalSemanticCache(path, "model");
			await expect(
				cache.upsertRecords([
					{ id: "bad", contentHash: "bad", values: [1, Number.NaN] },
				]),
			).rejects.toMatchObject({ code: "dimension" });
			await cache.upsertRecords([
				{ id: "good", contentHash: "good", values: [1, 0] },
			]);
			await expect(cache.query([1, 0, 0])).rejects.toMatchObject({
				code: "dimension",
			});
			cache.close();
		}));
});
