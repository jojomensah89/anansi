import { describe, expect, test } from "bun:test";
import appContext from "../../test/fixtures/tiktok/app-context.json" with {
	type: "json",
};
import favourites from "../../test/fixtures/tiktok/collect-item-list.json" with {
	type: "json",
};
import {
	isFavouritesRequest,
	isLikesRequest,
	isProfileView,
	profileUrl,
	readFavouriteMutation,
	readHandle,
	readHandleFromProfileHref,
	readItemList,
} from "./tiktok.ts";

const CONFIG = { watchUrls: ["/api/user/collect/item_list"] };

describe("telling Favourites from Likes", () => {
	test("accepts the collected-item listing", () => {
		expect(
			isFavouritesRequest(
				"https://www.tiktok.com/api/user/collect/item_list/?count=30&cursor=0",
				CONFIG,
			),
		).toBe(true);
	});

	test("refuses the Likes listing, which is a different action", () => {
		for (const url of [
			"https://www.tiktok.com/api/favorite/item_list/?count=30",
			"https://www.tiktok.com/api/user/favorite/item_list/?count=30",
		]) {
			expect(isFavouritesRequest(url, CONFIG)).toBe(false);
			expect(isLikesRequest(url)).toBe(true);
		}
	});

	test("a config that lists Likes still cannot turn likes into bookmarks", () => {
		expect(
			isFavouritesRequest("https://www.tiktok.com/api/favorite/item_list/", {
				watchUrls: ["/api/favorite/item_list"],
			}),
		).toBe(false);
	});

	test("ignores the profile and recommendation feeds", () => {
		expect(
			isFavouritesRequest("https://www.tiktok.com/api/post/item_list/", CONFIG),
		).toBe(false);
		expect(
			isFavouritesRequest("https://www.tiktok.com/api/recommend/item_list/", CONFIG),
		).toBe(false);
	});

	test("an empty config watches nothing at all", () => {
		expect(
			isFavouritesRequest("https://www.tiktok.com/api/user/collect/item_list/", {}),
		).toBe(false);
	});
});

describe("readItemList", () => {
	test("reads ids, cursor and whether more is coming", () => {
		expect(readItemList(favourites)).toEqual({
			ids: ["7400000000000000001", "7400000000000000002"],
			count: 2,
			cursor: "1756684800000",
			hasMore: true,
		});
	});

	test("the end of the list says so", () => {
		expect(readItemList({ itemList: [], hasMore: false, cursor: "0" })).toEqual({
			ids: [],
			count: 0,
			cursor: "0",
			hasMore: false,
		});
	});

	test("an unrecognised payload is an empty page, not a throw", () => {
		expect(readItemList({ statusCode: 10101 }).count).toBe(0);
		expect(readItemList(null).hasMore).toBe(false);
	});
});

describe("readHandle", () => {
	test("finds the signed-in handle in the current shape", () => {
		expect(readHandle(appContext.current)).toBe("example_viewer");
	});

	test("finds it in the older shape too", () => {
		expect(readHandle(appContext.legacy)).toBe("legacy_viewer");
	});

	test("returns nothing when nobody is signed in", () => {
		expect(readHandle(appContext.signedOut)).toBeNull();
		expect(readHandle(null)).toBeNull();
	});

	test("refuses a handle that could not be one", () => {
		expect(
			readHandle({ AppContext: { user: { uniqueId: "../../etc/passwd" } } }),
		).toBeNull();
	});

	test("falls back to the current signed-in profile navigation link", () => {
		expect(readHandleFromProfileHref("/@joojo44")).toBe("joojo44");
		expect(
			readHandleFromProfileHref("https://www.tiktok.com/@Example.Viewer"),
		).toBe("Example.Viewer");
	});

	test("refuses unrelated, nested, and malformed profile links", () => {
		for (const href of [
			"https://evil.example/@joojo44",
			"/@joojo44/video/123",
			"/@../../etc/passwd",
			"/login",
			null,
		]) {
			expect(readHandleFromProfileHref(href)).toBeNull();
		}
	});
});

describe("where to send the tab", () => {
	test("builds the profile URL a Favourites scan starts from", () => {
		expect(profileUrl("example_viewer")).toBe(
			"https://www.tiktok.com/@example_viewer",
		);
		expect(profileUrl("not a handle")).toBeNull();
	});

	test("knows when the tab is already there", () => {
		expect(
			isProfileView("https://www.tiktok.com/@example_viewer", "example_viewer"),
		).toBe(true);
		expect(
			isProfileView(
				"https://www.tiktok.com/@Example_Viewer?lang=en",
				"example_viewer",
			),
		).toBe(true);
		expect(isProfileView("https://www.tiktok.com/", "example_viewer")).toBe(
			false,
		);
		expect(
			isProfileView("https://www.tiktok.com/@someone_else", "example_viewer"),
		).toBe(false);
		expect(
			isProfileView("https://evil.example/@example_viewer", "example_viewer"),
		).toBe(false);
	});
});

describe("readFavouriteMutation", () => {
	const configured = {
		mutationUrl: "/api/commit/collect/",
		idField: "aweme_id",
		actionField: "action",
		savedValue: "1",
	};

	test("is inert until the server describes the request", () => {
		expect(
			readFavouriteMutation(
				"https://www.tiktok.com/api/commit/collect/?aweme_id=7400000000000000001&action=1",
				null,
				{},
			),
		).toBeNull();
	});

	test("reads the configured fields from the query", () => {
		expect(
			readFavouriteMutation(
				"https://www.tiktok.com/api/commit/collect/?aweme_id=7400000000000000001&action=1",
				null,
				configured,
			),
		).toEqual({ action: "save", videoId: "7400000000000000001" });
	});

	test("reads them from the body, and body wins over query", () => {
		expect(
			readFavouriteMutation(
				"https://www.tiktok.com/api/commit/collect/?action=1",
				"aweme_id=7400000000000000002&action=0",
				configured,
			),
		).toEqual({ action: "unsave", videoId: "7400000000000000002" });
	});

	test("ignores other endpoints and unusable ids", () => {
		expect(
			readFavouriteMutation(
				"https://www.tiktok.com/api/commit/item/digg/?aweme_id=7400000000000000001",
				null,
				configured,
			),
		).toBeNull();
		expect(
			readFavouriteMutation(
				"https://www.tiktok.com/api/commit/collect/?aweme_id=../../etc&action=1",
				null,
				configured,
			),
		).toBeNull();
	});
});
