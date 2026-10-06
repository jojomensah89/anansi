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
	test("makes retained TikTok rows visible when archive import is available", async () => {
		expect(HIDDEN_SOURCES).toEqual([]);
		expect(isHiddenSource("tiktok")).toBe(false);
		expect(isVisibleSource("x")).toBe(true);
		expect(isVisibleSource("tiktok")).toBe(true);

		const db = openTestDb();
		await upsertItems(db, [
			fixture("x", "visible", "shared-author"),
			fixture("tiktok", "retained", "shared-author"),
		]);
		const rows = await db.select({ id: items.id, source: items.source }).from(items);
		const tiktokId = rows.find((row) => row.source === "tiktok")?.id;
		expect(rows).toHaveLength(2);
		if (!tiktokId) throw new Error("expected retained TikTok row");

		expect((await listItems(db)).items.map((item) => item.source).sort()).toEqual(["tiktok", "x"]);
		expect(
			(await searchItemsPage(db, { query: "visibility boundary" })).items.map(
				(item) => item.source,
			),
		).toEqual(expect.arrayContaining(["x", "tiktok"]));
		expect((await recentSaves(db)).map((item) => item.source).sort()).toEqual(["tiktok", "x"]);
		expect((await findByAuthor(db, "shared-author")).map((item) => item.source).sort()).toEqual(["tiktok", "x"]);
		expect(await getItem(db, tiktokId)).not.toBeNull();
		expect(await countItems(db)).toBe(2);
		expect((await creators(db)).map((creator) => creator.source).sort()).toEqual(["tiktok", "x"]);
		expect((await sourceHealth(db)).map((health) => health.source).sort()).toEqual(["tiktok", "x"]);
		expect((await libraryStats(db)).bySource).toEqual({ x: 1, tiktok: 1 });
	});
});
