import { describe, expect, test } from "bun:test";
import { aiEnrichmentJobs, applyAiTags, itemTags, items, removeItemTag, reclassifyAiTopics, tags, type AnansiDb, setAiSettings, tagItems, upsertItems } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { AiProviderError } from "./ai.ts";
import { createLocalTaggingWorker } from "./local-tagging-worker.ts";

function setup() {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	return { db: local as unknown as AnansiDb };
}

async function addItem(db: AnansiDb, externalId: string, body = "SQLite FTS5 and MCP search") {
	await upsertItems(db, [{
		source: "web",
		externalId,
		url: `https://example.com/${externalId}`,
		kind: "article",
		title: "Local bookmark",
		body,
		savedAt: 1,
		savedAtIsExact: true,
		metrics: {},
		media: [],
		links: [],
		raw: {},
	}]);
	return (await db.select().from(items)).find((item) => item.externalId === externalId)!.id;
}

describe("local tagging worker", () => {
	test("applies bounded AI tags with provenance", async () => {
		const { db } = setup();
		const itemId = await addItem(db, "tagged-item");
		await setAiSettings(db, { autoTaggingEnabled: true });
		const worker = createLocalTaggingWorker(db, {
			model: "qwen-test",
			generateTags: async () => ["web-dev", "ai-ml"],
		});
		await worker.runOnce();
		const allAssignments = await db.select().from(itemTags);
		const allTags = await db.select().from(tags);
		const assigned = allAssignments.filter((assignment) => assignment.itemId === itemId).map((assignment) => ({ label: allTags.find((tag) => tag.id === assignment.tagId)?.label, provenance: assignment.provenance, model: assignment.model })).sort((a, b) => String(a.label).localeCompare(String(b.label)));
		expect(assigned).toEqual([
			{ label: "AI / ML", provenance: "ai", model: "qwen-test" },
			{ label: "Web Dev", provenance: "ai", model: "qwen-test" },
		]);
		expect((await worker.status()).complete).toBe(1);
	});

	test("reconciles tagging jobs without creating duplicate embedding jobs", async () => {
		const { db } = setup();
		await addItem(db, "tagging-only-item");
		await setAiSettings(db, { semanticSearchEnabled: true, autoTaggingEnabled: true });
		const worker = createLocalTaggingWorker(db, {
			model: "qwen-test",
			generateTags: async () => ["web-dev"],
		});
		await worker.runOnce();
		expect((await db.select().from(aiEnrichmentJobs)).map((job) => job.kind)).toEqual(["tagging"]);
	});

	test("does not override manual tags or suppressed AI assignments", async () => {
		const { db } = setup();
		const itemId = await addItem(db, "manual-item");
		await tagItems(db, [itemId], "Web Dev");
		await setAiSettings(db, { autoTaggingEnabled: true });
		await applyAiTags(db, itemId, ["web-dev", "ai-ml"], "qwen-test");
		const webDevTag = (await db.select().from(tags)).find((tag) => tag.label === "Web Dev");
		const manual = (await db.select().from(itemTags)).filter((assignment) => assignment.itemId === itemId && assignment.tagId === webDevTag?.id).map((assignment) => ({ provenance: assignment.provenance, label: webDevTag?.label }));
		expect(manual).toEqual([{ provenance: "manual", label: "Web Dev" }]);

		const aiMl = (await db.select().from(tags)).find((tag) => tag.label === "AI / ML");
		if (!aiMl) throw new Error("AI topic was not created");
		await removeItemTag(db, itemId, "AI / ML");
		await applyAiTags(db, itemId, ["ai-ml"], "qwen-test");
		expect((await db.select().from(itemTags)).filter((assignment) => assignment.itemId === itemId && assignment.tagId === aiMl.id)).toEqual([]);
	});

	test("reclassification prunes orphaned legacy AI labels but keeps manual labels", async () => {
		const { db } = setup();
		const itemId = await addItem(db, "reclassify-item");
		await db.insert(tags).values({ id: "legacy-ai", label: "old noisy label", color: "#6b7280", origin: "ai", kind: "custom" });
		await db.insert(tags).values({ id: "manual-custom", label: "my label", color: "#6b7280", origin: "manual", kind: "custom" });
		await db.insert(itemTags).values({ itemId, tagId: "manual-custom", provenance: "manual" });
		await reclassifyAiTopics(db);
		expect((await db.select().from(tags)).some((tag) => tag.id === "legacy-ai")).toBe(false);
		expect((await db.select().from(tags)).some((tag) => tag.id === "manual-custom")).toBe(true);
	});

	test("keeps a failed job retryable and does not break the worker", async () => {
		const { db } = setup();
		await addItem(db, "failed-item");
		await setAiSettings(db, { autoTaggingEnabled: true });
		const worker = createLocalTaggingWorker(db, {
			model: "qwen-test",
			generateTags: async () => { throw new AiProviderError("unavailable", "Ollama is unavailable"); },
		});
		await worker.runOnce();
		expect((await worker.status()).pending).toBe(1);
		expect((await worker.status()).failed).toBe(0);
	});

	test("does nothing while automatic tagging is disabled", async () => {
		const { db } = setup();
		await addItem(db, "disabled-item");
		const worker = createLocalTaggingWorker(db, { model: "qwen-test", generateTags: async () => ["ignored"] });
		await worker.runOnce();
		expect(await worker.status()).toEqual({ pending: 0, failed: 0, complete: 0 });
	});
});
