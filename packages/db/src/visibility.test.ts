import { describe, expect, test } from "bun:test";
import {
	countItems,
	creators,
	findByAuthor,
	getItem,
	libraryStats,
	listItems,
	recentSaves,
	searchItemsPage,
	sourceHealth,
	upsertItems,
} from "./index.ts";
import type { IngestItem } from "./queries.ts";
import { items } from "./schema.ts";
import { openTestDb } from "./test-db.ts";
import { HIDDEN_SOURCES, isHiddenSource, isVisibleSource } from "./visibility.ts";

const fixture = (source: string, externalId: string, authorHandle: string): IngestItem => ({
	source,
	externalId,
	url: `https://example.test/${source}/${externalId}`,
	kind: "post",
	authorHandle,
	body: "visibility boundary probe",
	savedAt: 100,
	savedAtIsExact: true,
	metrics: {},
	media: [],
	links: [],
	raw: {},
});

describe("source visibility boundary", () => {
	test("derives the hidden set from capabilities and keeps TikTok rows retained", async () => {
		expect(HIDDEN_SOURCES).toEqual(["tiktok"]);
		expect(isHiddenSource("tiktok")).toBe(true);
		expect(isVisibleSource("x")).toBe(true);
		expect(isVisibleSource("tiktok")).toBe(false);

		const db = openTestDb();
		await upsertItems(db, [
			fixture("x", "visible", "shared-author"),
			fixture("tiktok", "retained", "shared-author"),
		]);
		const rows = await db.select({ id: items.id, source: items.source }).from(items);
		const hiddenId = rows.find((row) => row.source === "tiktok")?.id;
		expect(rows).toHaveLength(2);
		if (!hiddenId) throw new Error("expected retained TikTok row");

		expect((await listItems(db)).items.map((item) => item.source)).toEqual(["x"]);
		expect(
			(await searchItemsPage(db, { query: "visibility boundary" })).items.map(
				(item) => item.source,
			),
		).toEqual(["x"]);
		expect((await recentSaves(db)).map((item) => item.source)).toEqual(["x"]);
		expect((await findByAuthor(db, "shared-author")).map((item) => item.source)).toEqual([
			"x",
		]);
		expect(await getItem(db, hiddenId)).toBeNull();
		expect(await countItems(db)).toBe(1);
		expect((await creators(db)).map((creator) => creator.source)).toEqual(["x"]);
		expect((await sourceHealth(db)).map((health) => health.source)).toEqual(["x"]);
		expect((await libraryStats(db)).bySource).toEqual({ x: 1 });
	});
});
