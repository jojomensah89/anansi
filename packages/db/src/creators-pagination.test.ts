import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
	creatorPage,
	InvalidCreatorCursorError,
	setArchived,
	upsertItems,
} from "./index.ts";
import type { IngestItem } from "./queries.ts";
import { items } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

const fixture = (
	source: string,
	externalId: string,
	authorHandle: string,
	authorName = authorHandle,
): IngestItem => ({
	source,
	externalId,
	url: `https://example.test/${source}/${externalId}`,
	kind: "post",
	authorHandle,
	authorName,
	body: `${authorHandle} saved reference`,
	savedAt: 100,
	savedAtIsExact: true,
	postedAt: 100,
	metrics: {},
	media: [],
	links: [],
	raw: {},
});

describe("creator pagination", () => {
	test("groups by source and handle, searches before grouping, and excludes archives", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			fixture("x", "x-shared-1", "shared", "Shared X"),
			fixture("x", "x-shared-2", "shared", "Shared X"),
			fixture("reddit", "reddit-shared", "shared", "Shared Reddit"),
			fixture("x", "x-other", "other", "Other"),
			fixture("x", "x-archived", "archived", "Archived"),
			fixture("tiktok", "hidden", "hidden", "Hidden"),
		]);
		const [archived] = await db
			.select({ id: items.id })
			.from(items)
			.where(and(eq(items.source, "x"), eq(items.externalId, "x-archived")));
		if (!archived) throw new Error("expected archived fixture id");
		const archivedId = archived.id;
		await setArchived(db, [archivedId], true);

		const page = await creatorPage(db, { limit: 10 });
		expect(page.total).toBe(3);
		expect(page.singleSaveCount).toBe(2);
		expect(page.topTenSaves).toBe(4);
		expect(
			page.creators.map(
				(creator) => `${creator.source}:${creator.authorHandle}`,
			),
		).toEqual(["x:shared", "reddit:shared", "x:other"]);

		const searched = await creatorPage(db, { query: "SHARED", limit: 10 });
		expect(searched.total).toBe(2);
		expect(searched.creators.map((creator) => creator.source)).toEqual([
			"x",
			"reddit",
		]);
	});

	test("continues with a filter-bound cursor and rejects a cursor from another query", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			fixture("x", "one", "one"),
			fixture("x", "two", "two"),
			fixture("x", "three", "three"),
		]);

		const first = await creatorPage(db, { limit: 1 });
		if (!first.nextCursor) throw new Error("expected a next cursor");
		const second = await creatorPage(db, {
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.creators).toHaveLength(1);
		expect(second.creators[0]?.authorHandle).not.toBe(
			first.creators[0]?.authorHandle,
		);
		await expect(
			creatorPage(db, { query: "different", cursor: first.nextCursor }),
		).rejects.toBeInstanceOf(InvalidCreatorCursorError);
		await expect(
			creatorPage(db, { cursor: "not-a-cursor" }),
		).rejects.toBeInstanceOf(InvalidCreatorCursorError);
	});
});
