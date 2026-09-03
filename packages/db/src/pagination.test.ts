import { describe, expect, test } from "bun:test";
import { upsertItems } from "./queries.ts";
import { listItems, recentSaves } from "./search.ts";
import { openTestDb } from "./test-db.ts";

const item = (externalId: string, savedAt: number, saveOrder?: number) => ({
	source: "x",
	externalId,
	url: `https://x.com/anansi/status/${externalId}`,
	kind: "post",
	body: externalId,
	postedAt: savedAt - 10,
	savedAt,
	savedAtIsExact: false,
	saveOrder,
	metrics: {},
	media: [],
	links: [],
	raw: {},
});

describe("saved-order pagination", () => {
	test("walks equal and null source-order rows exactly once", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item("same-a", 100, 100),
			item("same-b", 100, 100),
			item("same-c", 100, 100),
			item("null-a", 90),
			item("null-b", 80),
			item("ordered", 70, 10),
		]);

		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await listItems(db, { limit: 2, cursor });
			for (const row of page.items) {
				expect(seen.has(row.id)).toBe(false);
				seen.add(row.id);
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);

		expect(seen.size).toBe(6);
	});

	test("rejects malformed saved cursors", async () => {
		const db = openTestDb();
		await expect(
			listItems(db, { cursor: "not-a-cursor" }),
		).rejects.toMatchObject({
			name: "InvalidListCursorError",
		});
	});

	test("uses saved time before source-specific ordering across sources", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item("older-with-huge-source-key", 100, 1_700_000_000_000_000_000),
			{
				...item("newer-with-small-source-key", 200, 1),
				source: "github",
				kind: "repo",
				url: "https://github.com/anansi/newer",
			},
		]);

		const recent = await recentSaves(db, undefined, 2);
		expect(recent.map((row) => row.savedAt)).toEqual([200, 100]);
	});
});
