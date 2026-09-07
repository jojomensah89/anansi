import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiEnrichmentJobs, reconcileAiJobs, type AnansiDb, setAiSettings, upsertItems } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { AiProviderError } from "./ai.ts";
import { openLocalSemanticCache } from "./local-semantic-cache.ts";
import { createLocalSemanticWorker } from "./local-semantic-worker.ts";
import { createOllamaEmbeddingProvider } from "./ollama-embedding.ts";

function setup() {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	const db = local as unknown as AnansiDb;
	setActiveModel(db, "test-model");
	const directory = mkdtempSync(join(tmpdir(), "anansi-semantic-worker-test-"));
	const cache = openLocalSemanticCache(
		join(directory, "semantic.sqlite"),
		"test-model",
	);
	return { db, cache, directory };
}

function setActiveModel(db: AnansiDb, model: string) {
	(
		db as unknown as {
			$client: { prepare(sql: string): { run(...params: unknown[]): unknown } };
		}
	).$client
		.prepare("INSERT INTO ai_settings (id, embedding_model) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET embedding_model = excluded.embedding_model")
		.run(model);
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

	test("keeps an Ollama alias as the durable identity across items and runs", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [
				{
					source: "web",
					externalId: "alias-item-one",
					url: "https://example.com/alias-item-one",
					kind: "article",
					body: "First alias-backed embedding",
					savedAt: 1,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: {},
				},
				{
					source: "web",
					externalId: "alias-item-two",
					url: "https://example.com/alias-item-two",
					kind: "article",
					body: "Second alias-backed embedding",
					savedAt: 2,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: {},
				},
			]);
			await setAiSettings(db, { semanticSearchEnabled: true });
			setActiveModel(db, "embedding-alias");
			const requestedModels: string[] = [];
			const provider = createOllamaEmbeddingProvider({
				model: "embedding-alias",
				fetch: async (_input, init) => {
					const body = JSON.parse(String(init?.body)) as { model?: string };
					requestedModels.push(body.model ?? "");
					return Response.json({
						model: "resolved-embedding",
						embeddings: [[1, 0]],
					});
				},
			});

			const worker = createLocalSemanticWorker(db, cache, provider, 2);
			await worker.runOnce();
			expect(provider.model).toBe("embedding-alias");
			expect(provider.observedModel).toBe("resolved-embedding");
			expect(cache.model).toBe("embedding-alias");
			expect(cache.snapshot().indexed).toBe(2);
			expect(requestedModels).toEqual(["embedding-alias", "embedding-alias"]);

			await upsertItems(db, [{
				source: "web",
				externalId: "alias-item-three",
				url: "https://example.com/alias-item-three",
				kind: "article",
				body: "Third alias-backed embedding",
				savedAt: 3,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			}]);
			await worker.runOnce();
			expect(cache.snapshot().indexed).toBe(3);
			expect(requestedModels).toEqual([
			"embedding-alias",
			"embedding-alias",
			"embedding-alias",
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
			setActiveModel(db, model);
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
			setActiveModel(db, model);
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

	test("does not let an old model's failed jobs pause the active generation", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [{
				source: "web",
				externalId: "old-model-failure",
				url: "https://example.com/old-model-failure",
				kind: "article",
				body: "Current model should be ready",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			}]);
			await setAiSettings(db, { semanticSearchEnabled: true });
			await reconcileAiJobs(db, 10, "old-model", ["embedding"]);
			setActiveModel(db, "current-model");
			await db.update(aiEnrichmentJobs).set({ status: "failed", attempts: 5, lastError: "ai:unknown" });
			const worker = createLocalSemanticWorker(db, cache, {
				model: "current-model",
				dimensions: 2,
				embed: async () => [1, 0],
			});
			await worker.runOnce();
			expect(worker.status().state).toBe("ready");
			expect(worker.status().pending).toBe(0);
		} finally {
			cache.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("requeues completed jobs when a sidecar is recreated", async () => {
		const { db, cache, directory } = setup();
		try {
			await upsertItems(db, [
				{
					source: "web",
					externalId: "sidecar-rebuild",
					url: "https://example.com/sidecar-rebuild",
					kind: "article",
					body: "A vector that must survive a cache rebuild",
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
			await createLocalSemanticWorker(db, cache, provider).runOnce();
			expect(cache.snapshot().indexed).toBe(1);
			cache.close();

			const reopened = openLocalSemanticCache(
				join(directory, "semantic.sqlite"),
				"test-model",
			);
			try {
				const worker = createLocalSemanticWorker(db, reopened, provider);
				await worker.runOnce();
				expect(reopened.snapshot()).toMatchObject({
					state: "ready",
					indexed: 1,
					pending: 0,
				});
				expect(await reopened.query([1, 0])).toHaveLength(1);
			} finally {
				reopened.close();
			}
		} finally {
			// The first cache is closed above before reopening; Bun close is
			// intentionally idempotent for this test's cleanup path.
			try {
				cache.close();
			} catch {
				/* already closed */
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
