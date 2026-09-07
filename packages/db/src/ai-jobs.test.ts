import { describe, expect, test } from "bun:test";
import { aiEnrichmentJobs, items, reconcileAiJobs, setAiSettings, upsertItems } from "@anansi/db";
import { openTestDb } from "./test-db.ts";

describe("AI job reconciliation", () => {
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
});
