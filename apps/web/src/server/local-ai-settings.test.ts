import { describe, expect, test } from "bun:test";
import {
	type AnansiDb,
	aiEnrichmentJobs,
	aiSettings,
	getAiSettings,
	reconcileAiJobs,
	setAiSettings,
	upsertItems,
} from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { syncLocalAiModels } from "./local-ai-settings.ts";

function openTestDb(): AnansiDb {
	const db = openLocalDb(":memory:");
	migrateLocalDb(db);
	return db as unknown as AnansiDb;
}

describe("local AI model settings", () => {
	test("upserts both model identities while preserving toggles and queue generations", async () => {
		const db = openTestDb();
		syncLocalAiModels(db, {
			embeddingModel: "embeddinggemma",
			tagModel: "qwen-test",
		});
		expect(await getAiSettings(db)).toMatchObject({
			semanticSearchEnabled: 0,
			autoTaggingEnabled: 0,
			embeddingModel: "embeddinggemma",
			tagModel: "qwen-test",
		});
		await setAiSettings(db, {
			semanticSearchEnabled: true,
			autoTaggingEnabled: true,
		});
		syncLocalAiModels(db, {
			embeddingModel: " embeddinggemma ",
			tagModel: "qwen-test",
		});

		const settings = await getAiSettings(db);
		expect(settings).toMatchObject({
			semanticSearchEnabled: 1,
			autoTaggingEnabled: 1,
			embeddingModel: "embeddinggemma",
			tagModel: "qwen-test",
		});

		await upsertItems(db, [
			{
				source: "web",
				externalId: "local-model-settings",
				url: "https://example.com/local-model-settings",
				kind: "article",
				title: "Local model settings",
				body: "Queue work for the configured Ollama generations",
				savedAt: 1,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
		expect(await reconcileAiJobs(db, 10)).toBe(2);
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(
			jobs.some((job) => job.id.startsWith("embedding:embeddinggemma:")),
		).toBe(true);
		expect(jobs.some((job) => job.id.startsWith("tagging:qwen-test:"))).toBe(
			true,
		);

		// A provider change creates the new generations without disabling either
		// capability or mutating the old durable history.
		syncLocalAiModels(db, {
			embeddingModel: "nomic-embed-text",
			tagModel: "qwen-next",
		});
		expect(await reconcileAiJobs(db, 10)).toBe(2);
		expect((await db.select().from(aiSettings))[0]).toMatchObject({
			semanticSearchEnabled: 1,
			autoTaggingEnabled: 1,
		});
	});
});
