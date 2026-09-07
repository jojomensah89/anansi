import { describe, expect, test } from "bun:test";
import {
	type AnansiDb,
	aiEnrichmentJobs,
	claimAiJobs,
	reconcileAiJobs,
	setAiSettings,
	upsertItems,
} from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { createAiJobRunner } from "./ai-job-runner.ts";

function openTestDb() {
	const db = openLocalDb(":memory:");
	migrateLocalDb(db);
	return db as unknown as AnansiDb;
}

async function enableAi(
	db: AnansiDb,
	patch: { semanticSearchEnabled?: boolean; autoTaggingEnabled?: boolean },
	model = "test-model",
) {
	await setAiSettings(db, patch);
	(
		db as unknown as {
			$client: { prepare(sql: string): { run(...params: unknown[]): unknown } };
		}
	).$client
		.prepare(
			"UPDATE ai_settings SET embedding_model = ?, tag_model = ? WHERE id = 1",
		)
		.run(model, model);
}

function exec(db: AnansiDb, statement: string, ...params: unknown[]) {
	(
		db as unknown as {
			$client: { prepare(sql: string): { run(...params: unknown[]): unknown } };
		}
	).$client
		.prepare(statement)
		.run(...params);
}

describe("AI job runner", () => {
	test("claims a bounded batch and loads only the claimed item IDs", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-a",
				url: "https://example.com/runner-a",
				kind: "article",
				title: "First item",
				body: "First body",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
			{
				source: "web",
				externalId: "runner-b",
				url: "https://example.com/runner-b",
				kind: "article",
				title: "Second item",
				body: "Second body",
				savedAt: 2,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true });
		const seen: string[] = [];
		const runner = createAiJobRunner({
			db,
			batchSize: 1,
			reconcile: { limit: 10 },
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async (item) => {
					seen.push(item.id);
					return null;
				},
				publish: async () => {},
			},
		});

		expect(await runner.runOnce()).toEqual({
			claimed: 1,
			completed: 1,
			retrying: 0,
			failed: 0,
			skipped: 0,
		});
		expect(seen).toHaveLength(1);
		expect(
			(await db.select().from(aiEnrichmentJobs)).filter(
				(job) => job.status === "complete",
			),
		).toHaveLength(1);
	});

	test("fails a provider attempt without acknowledging the job", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-failure",
				url: "https://example.com/runner-failure",
				kind: "article",
				title: "Failure",
				body: "Retry me",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true });
		const runner = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async () => {
					throw new Error("provider unavailable");
				},
				publish: async () => {},
			},
		});

		expect(await runner.runOnce()).toMatchObject({
			claimed: 1,
			completed: 0,
			retrying: 1,
			failed: 0,
		});
		const [job] = await db.select().from(aiEnrichmentJobs);
		expect(job).toMatchObject({
			status: "retrying",
			attempts: 1,
			lastError: "ai:unknown",
		});
	});

	test("leaves work pending when a required projection capability is absent", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-no-vectorize",
				url: "https://example.com/runner-no-vectorize",
				kind: "article",
				title: "No vector binding",
				body: "Keep pending",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { semanticSearchEnabled: true });
		const unavailable = createAiJobRunner({
			db,
			enabled: false,
			reconcile: { limit: 10, model: "test-model" },
			executor: {
				kind: "embedding",
				model: "test-model",
				prepare: async () => {
					throw new Error("must not run");
				},
				publish: async () => {},
			},
		});
		await expect(unavailable.runOnce()).resolves.toEqual({
			claimed: 0,
			completed: 0,
			retrying: 0,
			failed: 0,
			skipped: 0,
		});
		await reconcileAiJobs(db, 10, "test-model", ["embedding"]);
		const [pending] = await db.select().from(aiEnrichmentJobs);
		expect(pending).toMatchObject({ status: "pending", attempts: 0 });

		const recovered = createAiJobRunner({
			db,
			executor: {
				kind: "embedding",
				model: "test-model",
				prepare: async () => [1, 0],
				publish: async () => {},
			},
		});
		expect(await recovered.runOnce()).toMatchObject({
			claimed: 1,
			completed: 1,
		});
	});

	test("does not claim an embedding job from another model", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-model",
				url: "https://example.com/runner-model",
				kind: "article",
				title: "Model-specific",
				body: "Embedding",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { semanticSearchEnabled: true }, "new-model");
		expect(await reconcileAiJobs(db, 10, "old-model", ["embedding"])).toBe(1);
		const runner = createAiJobRunner({
			db,
			batchSize: 2,
			reconcile: { limit: 10, model: "new-model" },
			executor: {
				kind: "embedding",
				model: "new-model",
				prepare: async () => [],
				publish: async () => {},
			},
		});
		await runner.runOnce();
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(jobs).toHaveLength(2);
		expect(
			jobs.find((job) => job.id.startsWith("embedding:new-model:"))?.status,
		).toBe("complete");
		expect(
			jobs.find((job) => job.id.startsWith("embedding:old-model:"))?.status,
		).toBe("pending");
	});

	test("does not publish or complete when the lease expires during preparation", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-expired",
				url: "https://example.com/runner-expired",
				kind: "article",
				title: "Lease expiry",
				body: "Leave this job reclaimable",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true });
		let published = 0;
		const runner = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async () => {
					exec(db, "UPDATE ai_enrichment_jobs SET lease_until = 0");
					return ["prepared"];
				},
				publish: async () => {
					published += 1;
				},
			},
		});
		const outcome = await runner.runOnce();
		expect(outcome).toMatchObject({ claimed: 1, completed: 0, skipped: 1 });
		expect(
			outcome.completed + outcome.retrying + outcome.failed + outcome.skipped,
		).toBe(outcome.claimed);
		expect(published).toBe(0);
		const [expired] = await db.select().from(aiEnrichmentJobs);
		expect(expired?.status).toBe("running");
		const [reclaimed] = await claimAiJobs(
			db,
			"tagging",
			1,
			Math.floor(Date.now() / 1000) + 1,
			"test-model",
		);
		expect(reclaimed?.token).toBeDefined();
	});

	test("fences tagging publication when the active model changes during preparation", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-tag-model-switch",
				url: "https://example.com/runner-tag-model-switch",
				kind: "article",
				title: "Tag model switch",
				body: "Use the new generation",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true }, "tag-model-a");
		let published = 0;
		const runner = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "tagging",
				model: "tag-model-a",
				prepare: async () => {
					exec(db, "UPDATE ai_settings SET tag_model = 'tag-model-b'");
					return ["old-model-result"];
				},
				publish: async () => {
					published += 1;
				},
			},
		});
		const outcome = await runner.runOnce();
		expect(outcome).toMatchObject({ claimed: 1, completed: 0, skipped: 1 });
		expect(published).toBe(0);
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(
			jobs.find((job) => job.id.startsWith("tagging:tag-model-a:")),
		).toMatchObject({
			status: "pending",
			attempts: 0,
		});
		expect(
			jobs.find((job) => job.id.startsWith("tagging:tag-model-b:"))?.status,
		).toBe("pending");

		// Switching back later must allow the deferred A generation to run.
		await enableAi(db, { autoTaggingEnabled: true }, "tag-model-a");
		const recovered = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "tagging",
				model: "tag-model-a",
				prepare: async () => ["current-model-result"],
				publish: async () => {
					published += 1;
				},
			},
		});
		expect(await recovered.runOnce()).toMatchObject({
			claimed: 1,
			completed: 1,
		});
		expect(published).toBe(1);
	});

	test("fences embedding publication when the feature is disabled during preparation", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-embedding-disable",
				url: "https://example.com/runner-embedding-disable",
				kind: "article",
				title: "Embedding disable",
				body: "Do not publish after disable",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { semanticSearchEnabled: true }, "embed-model");
		let published = 0;
		const runner = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "embedding",
				model: "embed-model",
				prepare: async () => {
					exec(db, "UPDATE ai_settings SET semantic_search_enabled = 0");
					return [1, 0];
				},
				publish: async () => {
					published += 1;
				},
			},
		});
		const outcome = await runner.runOnce();
		expect(outcome).toMatchObject({ claimed: 1, completed: 0, skipped: 1 });
		expect(published).toBe(0);
		expect((await db.select().from(aiEnrichmentJobs))[0]).toMatchObject({
			status: "pending",
			attempts: 0,
		});

		// Disabling during inference must not lose the job; re-enabling the same
		// generation later should claim and publish it normally.
		await enableAi(db, { semanticSearchEnabled: true }, "embed-model");
		const recovered = createAiJobRunner({
			db,
			reconcile: { limit: 10 },
			executor: {
				kind: "embedding",
				model: "embed-model",
				prepare: async () => [1, 0],
				publish: async () => {
					published += 1;
				},
			},
		});
		expect(await recovered.runOnce()).toMatchObject({
			claimed: 1,
			completed: 1,
		});
		expect(published).toBe(1);
	});

	test("skips a job whose content changed after reconciliation", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-stale",
				url: "https://example.com/runner-stale",
				kind: "article",
				title: "Changed",
				body: "Current body",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true });
		expect(await reconcileAiJobs(db, 10, "test-model", ["tagging"])).toBe(1);
		let prepared = 0;
		let published = 0;
		const runner = createAiJobRunner({
			db,
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async (item) => {
					prepared += 1;
					await upsertItems(db, [
						{
							source: item.source,
							externalId: item.externalId,
							url: item.url,
							kind: item.kind,
							title: item.title ?? undefined,
							body: "A much longer changed body during inference",
							authorHandle: item.authorHandle ?? undefined,
							authorName: item.authorName ?? undefined,
							savedAt: item.savedAt,
							savedAtIsExact: Boolean(item.savedAtExact),
							metrics: JSON.parse(item.metrics) as Record<string, number>,
							media: [],
							links: [],
							raw: JSON.parse(item.raw),
						},
					]);
					return null;
				},
				publish: async () => {
					published += 1;
				},
			},
		});

		expect(await runner.runOnce()).toMatchObject({
			claimed: 1,
			completed: 0,
			skipped: 1,
		});
		expect(prepared).toBe(1);
		expect(published).toBe(0);
		expect((await db.select().from(aiEnrichmentJobs))[0]?.status).toBe(
			"complete",
		);
	});

	test("does not publish after another worker reclaims the token", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			{
				source: "web",
				externalId: "runner-reclaimed",
				url: "https://example.com/runner-reclaimed",
				kind: "article",
				title: "Reclaimed",
				body: "Another worker wins",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		await enableAi(db, { autoTaggingEnabled: true });
		const runner = createAiJobRunner({
			db,
			reconcile: { limit: 10, model: "test-model" },
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async () => {
					await db
						.update(aiEnrichmentJobs)
						.set({ claimToken: "other-worker-token" });
					return ["prepared"];
				},
				publish: async () => {
					throw new Error("publication must be fenced");
				},
			},
		});
		expect(await runner.runOnce()).toMatchObject({
			claimed: 1,
			completed: 0,
			retrying: 0,
			failed: 0,
			skipped: 1,
		});
		const [job] = await db.select().from(aiEnrichmentJobs);
		expect(job).toMatchObject({
			status: "running",
			claimToken: "other-worker-token",
		});
	});

	test("persists stable failure codes and terminal dispositions", async () => {
		const db = openTestDb();
		const codes = [
			"quota",
			"unavailable",
			"malformed",
			"dimension",
			"unknown",
		] as const;
		await upsertItems(
			db,
			codes.map((code, index) => ({
				source: "web",
				externalId: `runner-${code}`,
				url: `https://example.com/runner-${code}`,
				kind: "article",
				title: code,
				body: code,
				savedAt: index + 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			})),
		);
		await enableAi(db, { autoTaggingEnabled: true });
		const runner = createAiJobRunner({
			db,
			batchSize: 5,
			reconcile: { limit: 10, model: "test-model" },
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async (item) => {
					throw { code: item.externalId.replace("runner-", "") };
				},
				publish: async () => {},
			},
		});
		expect(await runner.runOnce()).toMatchObject({
			claimed: 5,
			completed: 0,
			retrying: 3,
			failed: 2,
			skipped: 0,
		});
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(jobs.map((job) => job.lastError).sort()).toEqual([
			"ai:dimension",
			"ai:malformed",
			"ai:quota",
			"ai:unavailable",
			"ai:unknown",
		]);
		expect(jobs.filter((job) => job.status === "retrying")).toHaveLength(3);
		expect(jobs.filter((job) => job.status === "failed")).toHaveLength(2);
	});

	test("contains missing-item cleanup failures and continues the batch", async () => {
		const db = openTestDb();
		(db as unknown as { $client: { exec(sql: string): void } }).$client.exec(
			"PRAGMA foreign_keys = OFF",
		);
		await enableAi(db, { autoTaggingEnabled: true });
		await db.insert(aiEnrichmentJobs).values([
			{
				id: "tagging:test-model:orphan-a:hash",
				itemId: "orphan-a",
				kind: "tagging",
				contentHash: "hash",
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "tagging:test-model:orphan-b:hash",
				itemId: "orphan-b",
				kind: "tagging",
				contentHash: "hash",
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		const runner = createAiJobRunner({
			db,
			batchSize: 2,
			executor: {
				kind: "tagging",
				model: "test-model",
				prepare: async () => null,
				publish: async () => {},
				onMissingItem: async (job) => {
					if (job.itemId === "orphan-a")
						throw new Error("sidecar cleanup failed");
				},
			},
		});
		expect(await runner.runOnce()).toMatchObject({
			claimed: 2,
			completed: 0,
			retrying: 1,
			failed: 0,
			skipped: 1,
		});
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(jobs.find((job) => job.itemId === "orphan-a")?.status).toBe(
			"retrying",
		);
		expect(jobs.find((job) => job.itemId === "orphan-b")?.status).toBe(
			"complete",
		);
	});
});
