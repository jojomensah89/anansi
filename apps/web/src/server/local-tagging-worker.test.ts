import { describe, expect, test } from "bun:test";
import { aiEnrichmentJobs, applyAiTags, itemTags, items, removeItemTag, tags, type AnansiDb, setAiSettings, tagItems, upsertItems } from "@anansi/db";
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
			generateTags: async () => ["SQLite", "MCP-server"],
		});
		await worker.runOnce();
		const allAssignments = await db.select().from(itemTags);
		const allTags = await db.select().from(tags);
		const assigned = allAssignments.filter((assignment) => assignment.itemId === itemId).map((assignment) => ({ label: allTags.find((tag) => tag.id === assignment.tagId)?.label, provenance: assignment.provenance, model: assignment.model })).sort((a, b) => String(a.label).localeCompare(String(b.label)));
		expect(assigned).toEqual([
			{ label: "mcp-server", provenance: "ai", model: "qwen-test" },
			{ label: "sqlite", provenance: "ai", model: "qwen-test" },
		]);
		expect((await worker.status()).complete).toBe(1);
	});

	test("reconciles tagging jobs without creating duplicate embedding jobs", async () => {
		const { db } = setup();
		await addItem(db, "tagging-only-item");
		await setAiSettings(db, { semanticSearchEnabled: true, autoTaggingEnabled: true });
		const worker = createLocalTaggingWorker(db, {
			model: "qwen-test",
			generateTags: async () => ["sqlite"],
		});
		await worker.runOnce();
		expect((await db.select().from(aiEnrichmentJobs)).map((job) => job.kind)).toEqual(["tagging"]);
	});

	test("does not override manual tags or suppressed AI assignments", async () => {
		const { db } = setup();
		const itemId = await addItem(db, "manual-item");
		await tagItems(db, [itemId], "sqlite");
		await setAiSettings(db, { autoTaggingEnabled: true });
		await applyAiTags(db, itemId, ["sqlite", "mcp"], "qwen-test");
		const sqliteTag = (await db.select().from(tags)).find((tag) => tag.label === "sqlite");
		const manual = (await db.select().from(itemTags)).filter((assignment) => assignment.itemId === itemId && assignment.tagId === sqliteTag?.id).map((assignment) => ({ provenance: assignment.provenance, label: sqliteTag?.label }));
		expect(manual).toEqual([{ provenance: "manual", label: "sqlite" }]);

		const mcp = (await db.select().from(tags)).find((tag) => tag.label === "mcp");
		if (!mcp) throw new Error("AI tag was not created");
		await removeItemTag(db, itemId, "mcp");
		await applyAiTags(db, itemId, ["mcp"], "qwen-test");
		expect((await db.select().from(itemTags)).filter((assignment) => assignment.itemId === itemId && assignment.tagId === mcp.id)).toEqual([]);
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
