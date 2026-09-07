import { describe, expect, test } from "bun:test";
import { aiEnrichmentJobs, aiProgress, applyAiTags, claimAiJobs, completeAiJob, contentHash, failAiJob, items, reconcileAiJobs, releaseAiJob, searchableText, setAiSettings, upsertItems, type AnansiDb } from "@anansi/db";
import { openTestDb } from "./test-db.ts";
import {
	AI_JOB_RECONCILIATION_CHUNK_SIZE,
	chunkAiJobRows,
	mutationChanges,
} from "./ai-jobs.ts";

type SqliteClient = {
	prepare(statement: string): { run(...params: unknown[]): unknown };
};

function exec(db: AnansiDb, statement: string, ...params: unknown[]) {
	(db as unknown as { $client: SqliteClient }).$client
		.prepare(statement)
		.run(...params);
}

describe("AI job reconciliation", () => {
	test("normalizes SQLite root and D1 meta mutation counts", () => {
		expect(mutationChanges({ changes: 3 })).toBe(3);
		expect(mutationChanges({ meta: { changes: 4 } })).toBe(4);
		expect(mutationChanges({ changes: 0, meta: { changes: 9 } })).toBe(0);
		expect(mutationChanges({ meta: null })).toBe(0);
		expect(mutationChanges(undefined)).toBe(0);
	});

	test("chunks the default reconciliation batch without overlap or bind overflow", () => {
		const rows = Array.from({ length: 100 }, (_, index) => index);
		const chunks = chunkAiJobRows(rows);
		expect(AI_JOB_RECONCILIATION_CHUNK_SIZE).toBe(16);
		expect(chunks.map((chunk) => chunk.length)).toEqual([
			16,
			16,
			16,
			16,
			16,
			16,
			4,
		]);
		expect(chunks.flat()).toEqual(rows);
		expect(new Set(chunks.flat()).size).toBe(rows.length);
		// Reconciliation supplies six columns per row, so the largest chunk is
		// 96 bound parameters, below D1's 100-parameter limit.
		expect(Math.max(...chunks.map((chunk) => chunk.length)) * 6).toBeLessThanOrEqual(100);
	});

	test("eventually queues items beyond the first 500 rows", async () => {
		const db = openTestDb();
		await upsertItems(db, Array.from({ length: 501 }, (_, index) => ({
			source: "web",
			externalId: `reconcile-${index}`,
			url: `https://example.com/reconcile-${index}`,
			kind: "article",
			title: `Bookmark ${index}`,
			body: "A bookmark that needs automatic topic tagging",
			savedAt: index + 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		})));
		await setAiSettings(db, { autoTaggingEnabled: true });

		for (let pass = 0; pass < 5; pass += 1) {
			expect(await reconcileAiJobs(db, 100, undefined, ["tagging"])).toBe(100);
		}
		expect((await db.select().from(aiEnrichmentJobs)).length).toBe(500);
		expect(await reconcileAiJobs(db, 100, undefined, ["tagging"])).toBe(1);
		expect((await db.select().from(aiEnrichmentJobs)).length).toBe(501);
		expect((await db.select().from(items)).length).toBe(501);
	});

	test("qualifies tagging generations and scopes progress to the active model", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "tag-model-generation",
			url: "https://example.com/tag-model-generation",
			kind: "article",
			title: "Tag generation",
			body: "Model-specific tags",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 10, "old-tag-model", ["tagging"]);
		await reconcileAiJobs(db, 10, "current-tag-model", ["tagging"]);
		expect(await aiProgress(db, "tagging", "current-tag-model")).toMatchObject({ pending: 1, failed: 0 });
		expect(await claimAiJobs(db, "tagging", 1, undefined, "current-tag-model")).toHaveLength(1);
		expect((await db.select().from(aiEnrichmentJobs)).find((job) => job.id.startsWith("tagging:old-tag-model:"))?.status).toBe("pending");
	});

	test("uses an exact case-sensitive model prefix", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "prefix-model",
			url: "https://example.com/prefix-model",
			kind: "article",
			title: "Prefix",
			body: "Prefix matching",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { semanticSearchEnabled: true });
		const [item] = await db.select().from(items);
		if (!item) throw new Error("test item missing");
		await reconcileAiJobs(db, 10, "m%_odel", ["embedding"]);
		await db.insert(aiEnrichmentJobs).values([
			{ id: `embedding:M%_odel:${item.id}:upper`, itemId: item.id, kind: "embedding", contentHash: "upper", createdAt: 1, updatedAt: 1 },
			{ id: `embedding:mX_odel:${item.id}:near`, itemId: item.id, kind: "embedding", contentHash: "near", createdAt: 1, updatedAt: 1 },
		]);
		const claimed = await claimAiJobs(db, "embedding", 10, undefined, "m%_odel");
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.id.startsWith("embedding:m%_odel:")).toBe(true);
	});

	test("reports whether token-conditional transitions affected a row", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "transition-token",
			url: "https://example.com/transition-token",
			kind: "article",
			title: "Token",
			body: "Token transitions",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 10, "token-model", ["tagging"]);
		const [job] = await claimAiJobs(db, "tagging", 1, undefined, "token-model");
		if (!job) throw new Error("job was not claimed");
		expect(await completeAiJob(db, job.id, "wrong-token")).toBe(false);
		expect(await failAiJob(db, job.id, "wrong-token", job.attempts, "unavailable")).toBe(false);
		expect(await completeAiJob(db, job.id, job.token)).toBe(true);
		expect(await completeAiJob(db, job.id, job.token)).toBe(false);
	});

	test("does not reclaim a row completed after candidate selection", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "claim-race",
			url: "https://example.com/claim-race",
			kind: "article",
			title: "Claim race",
			body: "The completed row must stay complete",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 10, "race-model", ["tagging"]);
		let injected = false;
		const raceDb = new Proxy(db, {
			get(target, property, receiver) {
				if (property !== "update") return Reflect.get(target, property, receiver);
				return (table: unknown) => {
					if (!injected) {
						injected = true;
						const row = target.$client
							.prepare("SELECT id FROM ai_enrichment_jobs LIMIT 1")
							.get() as { id: string };
						target.$client
							.prepare("UPDATE ai_enrichment_jobs SET status = 'complete', claim_token = NULL, lease_until = 0 WHERE id = ?")
							.run(row.id);
					}
					return target.update(table as never);
				};
			}
		}) as unknown as typeof db;
		const claimed = await claimAiJobs(raceDb, "tagging", 1, undefined, "race-model");
		expect(claimed).toHaveLength(0);
		expect((await db.select().from(aiEnrichmentJobs))[0]?.status).toBe("complete");
	});

	test("leaves expired owners running for a later reclaim", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "expired-owner",
			url: "https://example.com/expired-owner",
			kind: "article",
			title: "Lease",
			body: "Lease expiration",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 10, "lease-model", ["tagging"]);
		const [job] = await claimAiJobs(db, "tagging", 1, 100, "lease-model");
		if (!job) throw new Error("job was not claimed");
		expect(await completeAiJob(db, job.id, job.token, 221)).toBe(false);
		expect(await failAiJob(db, job.id, job.token, job.attempts, "unavailable", 221)).toBe(false);
		expect((await db.select().from(aiEnrichmentJobs))[0]).toMatchObject({ status: "running", claimToken: job.token });
		const [reclaimed] = await claimAiJobs(db, "tagging", 1, 221, "lease-model");
		expect(reclaimed?.token).toBeDefined();
		expect(reclaimed?.token).not.toBe(job.token);
	});

	test("releases a settings-fenced claim without burning its attempt", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "release-settings",
			url: "https://example.com/release-settings",
			kind: "article",
			title: "Release",
			body: "Release this claim",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 10, "release-model", ["tagging"]);
		const [job] = await claimAiJobs(db, "tagging", 1, undefined, "release-model");
		if (!job) throw new Error("job was not claimed");
		expect(await releaseAiJob(db, job.id, "wrong-token", job.attempts)).toBe(false);
		expect(await releaseAiJob(db, job.id, job.token, job.attempts)).toBe(true);
		expect((await db.select().from(aiEnrichmentJobs))[0]).toMatchObject({
			status: "pending",
			attempts: 0,
			claimToken: null,
		});
	});

	test("retires legacy tagging rows without retagging a current active projection", async () => {
		const db = openTestDb();
		await upsertItems(db, [{
			source: "web",
			externalId: "legacy-tagging",
			url: "https://example.com/legacy-tagging",
			kind: "article",
			title: "Legacy",
			body: "Retain current tags",
			savedAt: 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		}]);
		const [item] = await db.select().from(items);
		if (!item) throw new Error("test item missing");
		exec(db as unknown as AnansiDb, "INSERT INTO ai_settings (id, auto_tagging_enabled, tag_model) VALUES (1, 1, 'active-tag-model') ON CONFLICT(id) DO UPDATE SET auto_tagging_enabled = 1, tag_model = 'active-tag-model'");
		await applyAiTags(db, item.id, ["web-dev"], "active-tag-model");
		const hash = await contentHash(searchableText(item));
		await db.insert(aiEnrichmentJobs).values({
			id: `tagging:${item.id}:${hash}`,
			itemId: item.id,
			kind: "tagging",
			contentHash: hash,
			status: "complete",
			createdAt: 1,
			updatedAt: 1,
		});
		await reconcileAiJobs(db, 10, undefined, ["tagging"]);
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(jobs.some((job) => job.id === `tagging:${item.id}:${hash}`)).toBe(false);
		expect(jobs.find((job) => job.id === `tagging:active-tag-model:${item.id}:${hash}`)?.status).toBe("complete");
	});

	test("bounds legacy cleanup while normal reconciliation keeps progressing", async () => {
		const db = openTestDb();
		await setAiSettings(db, { autoTaggingEnabled: true });
		await upsertItems(db, Array.from({ length: 45 }, (_, index) => ({
			source: "web",
			externalId: `legacy-large-${index}`,
			url: `https://example.com/legacy-large-${index}`,
			kind: "article",
			title: `Legacy queue item ${index}`,
			body: "A queued legacy tagging job",
			savedAt: index + 1,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		})));
		const currentItems = await db.select().from(items).orderBy(items.savedAt);
		await db.insert(aiEnrichmentJobs).values(
			await Promise.all(currentItems.map(async (item) => {
				const hash = await contentHash(searchableText(item));
				return {
					id: `tagging:${item.id}:${hash}`,
					itemId: item.id,
					kind: "tagging" as const,
					contentHash: hash,
					status: "pending",
					createdAt: 1,
					updatedAt: 1,
				};
			})),
		);

		const isLegacy = (job: typeof aiEnrichmentJobs.$inferSelect) =>
			job.id === `tagging:${job.itemId}:${job.contentHash}`;
		expect(await reconcileAiJobs(db, 1, undefined, ["tagging"])).toBe(1);
		expect((await db.select().from(aiEnrichmentJobs)).filter(isLegacy)).toHaveLength(25);

		// Two more bounded passes retire the remainder; each pass still has room
		// to enqueue current-generation work instead of spending the whole run on
		// per-row migration writes.
		expect(await reconcileAiJobs(db, 1, undefined, ["tagging"])).toBe(1);
		expect((await db.select().from(aiEnrichmentJobs)).filter(isLegacy)).toHaveLength(5);
		expect(await reconcileAiJobs(db, 1, undefined, ["tagging"])).toBe(1);
		expect((await db.select().from(aiEnrichmentJobs)).filter(isLegacy)).toHaveLength(0);
	});
});
