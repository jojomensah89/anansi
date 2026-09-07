import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnansiDb, setAiSettings, upsertItems } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { AiProviderError } from "./ai.ts";
import { openLocalSemanticCache } from "./local-semantic-cache.ts";
import { createLocalSemanticWorker } from "./local-semantic-worker.ts";

function setup() {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	const db = local as unknown as AnansiDb;
	const directory = mkdtempSync(join(tmpdir(), "anansi-semantic-worker-test-"));
	const cache = openLocalSemanticCache(
		join(directory, "semantic.sqlite"),
		"test-model",
	);
	return { db, cache, directory };
}

describe("local semantic worker", () => {
	test("indexes new items through the durable embedding queue", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [
				{
					source: "web",
					externalId: "worker-item",
					url: "https://example.com/worker-item",
					kind: "article",
					title: "Vector retrieval",
					body: "Similar documents",
					savedAt: 1,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: {},
				},
			]);
			await setAiSettings(db, { semanticSearchEnabled: true });
			const provider = {
				model: "test-model",
				dimensions: 2,
				embed: async () => [1, 0],
			};
			const worker = createLocalSemanticWorker(db, cache, provider);
			await worker.runOnce();
			expect(cache.snapshot()).toMatchObject({
				state: "ready",
				indexed: 1,
				pending: 0,
				dimension: 2,
			});
			await expect(cache.query([1, 0])).resolves.toEqual([
				{ id: expect.any(String), score: 1 },
			]);
		} finally {
			cache.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps jobs pending and reports an error when Ollama is unavailable", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [
				{
					source: "web",
					externalId: "failed-item",
					url: "https://example.com/failed-item",
					kind: "article",
					body: "A failed embedding",
					savedAt: 1,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: {},
				},
			]);
			await setAiSettings(db, { semanticSearchEnabled: true });
			const provider = {
				model: "test-model",
				dimensions: 2,
				embed: async () => {
					throw new AiProviderError("unavailable", "Ollama is unavailable");
				},
			};
			const worker = createLocalSemanticWorker(db, cache, provider);
			await worker.runOnce();
			expect(worker.status().state).toBe("unavailable");
			expect(worker.status().pending).toBeGreaterThan(0);
		} finally {
			cache.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rebuilds the active generation when the developer changes models", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [
				{
					source: "web",
					externalId: "model-switch",
					url: "https://example.com/model-switch",
					kind: "article",
					body: "Model-specific vectors",
					savedAt: 1,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: {},
				},
			]);
			await setAiSettings(db, { semanticSearchEnabled: true });
			let model = "first-model";
			const provider = {
				get model() {
					return model;
				},
				dimensions: 2,
				embed: async () => (model === "first-model" ? [1, 0] : [0, 1]),
			};
			const worker = createLocalSemanticWorker(db, cache, provider);
			await worker.runOnce();
			expect(await cache.query([1, 0])).toHaveLength(1);
			model = "second-model";
			await worker.runOnce();
			expect(cache.model).toBe("second-model");
			expect(await cache.query([0, 1])).toEqual([
				{ id: expect.any(String), score: 1 },
			]);
			expect(await cache.query([1, 0])).toEqual([
				{ id: expect.any(String), score: 0 },
			]);
		} finally {
			cache.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
