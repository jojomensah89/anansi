import { describe, expect, test } from "bun:test";
import favourites from "../../../../apps/extension/test/fixtures/tiktok/collect-item-list.json" with {
	type: "json",
};
import { parseItemList } from "./parse.ts";

const ctx = { importedAt: 1_756_700_000 };

describe("parseItemList", () => {
	test("reads a Favourites page into items", () => {
		const items = parseItemList(favourites, ctx);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			source: "tiktok",
			externalId: "7400000000000000001",
			url: "https://www.tiktok.com/@example_creator/video/7400000000000000001",
			authorHandle: "example_creator",
			authorName: "Example Creator",
			body: "A sanitized favourited video caption #example",
			postedAt: 1_756_684_800,
		});
	});

	test("keeps the poster frame and nothing heavier", () => {
		const [first] = parseItemList(favourites, ctx);

		expect(first?.media).toEqual([
			{
				kind: "video_poster",
				originUrl:
					"https://p16-sign.tiktokcdn-us.com/example-cover~tplv-photomode.jpeg",
			},
		]);
		// The video file itself is never referenced, which is the whole media
		// policy for this source.
		expect(JSON.stringify(first?.media)).not.toContain(".mp4");
	});

	test("counts what the page reported", () => {
		const [first] = parseItemList(favourites, ctx);

		expect(first?.metrics).toEqual({
			likes: 1200,
			comments: 56,
			shares: 34,
			plays: 78900,
		});
	});

	test("orders items within a page as they arrived", () => {
		const [first, second] = parseItemList(favourites, ctx);

		expect(first?.saveOrder).toBeGreaterThan(second?.saveOrder ?? 0);
		// TikTok gives no saved-at, so the stamp is honest about being ours.
		expect(first?.savedAtIsExact).toBe(false);
		expect(first?.savedAt).toBe(ctx.importedAt);
	});

	test("an item with no id is skipped rather than half-imported", () => {
		const items = parseItemList(
			{ itemList: [{ desc: "no id here" }, { id: "7400000000000000009" }] },
			ctx,
		);

		expect(items).toHaveLength(1);
		expect(items[0]?.externalId).toBe("7400000000000000009");
	});

	test("a payload with nothing in it parses to nothing", () => {
		expect(parseItemList({ statusCode: 10101 }, ctx)).toEqual([]);
		expect(parseItemList({ itemList: [] }, ctx)).toEqual([]);
	});

	test("a video with no author still gets a usable link", () => {
		const [item] = parseItemList(
			{ itemList: [{ id: "7400000000000000010", desc: "" }] },
			ctx,
		);

		expect(item?.url).toBe("https://www.tiktok.com/video/7400000000000000010");
	});
});
