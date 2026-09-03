import { describe, expect, test } from "bun:test";
import legacyPage from "../../test/fixtures/x/bookmarks-legacy.json" with {
	type: "json",
};
import mutations from "../../test/fixtures/x/mutations.json" with {
	type: "json",
};
import timelinePage from "../../test/fixtures/x/bookmarks-v2.json" with {
	type: "json",
};
import {
	buildTimelineUrl,
	isMutationAccepted,
	readBookmarkMutation,
	readRequestTemplate,
	readTimelinePage,
	shouldStopImport,
	tweetUrl,
} from "./x.ts";

const SHAPE = { cursorPrefix: "cursor-bottom", entryPrefix: "tweet-" };

describe("readBookmarkMutation", () => {
	test("reads a save from a CreateBookmark request", () => {
		const { url, body } = mutations.createBookmarkRequest;
		expect(readBookmarkMutation(url, body)).toEqual({
			action: "save",
			tweetId: "1900000000000000001",
		});
	});

	test("reads an unsave from a DeleteBookmark request", () => {
		const { url, body } = mutations.deleteBookmarkRequest;
		expect(readBookmarkMutation(url, body)).toEqual({
			action: "unsave",
			tweetId: "1900000000000000002",
		});
	});

	test("accepts an already-parsed body, as the XHR path supplies", () => {
		const { url } = mutations.createBookmarkRequest;
		expect(
			readBookmarkMutation(url, { variables: { tweet_id: "1234567890" } }),
		).toEqual({ action: "save", tweetId: "1234567890" });
	});

	test("ignores an operation that is not a bookmark mutation", () => {
		const { url, body } = mutations.unrelatedRequest;
		expect(readBookmarkMutation(url, body)).toBeNull();
	});

	test("returns nothing without a usable tweet id", () => {
		const { url } = mutations.createBookmarkRequest;
		expect(readBookmarkMutation(url, "{}")).toBeNull();
		expect(readBookmarkMutation(url, "not json")).toBeNull();
		expect(
			readBookmarkMutation(url, { variables: { tweet_id: "../../etc" } }),
		).toBeNull();
		expect(
			readBookmarkMutation(url, { variables: { tweet_id: "" } }),
		).toBeNull();
	});
});

describe("isMutationAccepted", () => {
	test("accepts the responses X returns for both mutations", () => {
		const created = mutations.createBookmarkResponse;
		const deleted = mutations.deleteBookmarkResponse;
		expect(isMutationAccepted(created.status, created.body)).toBe(true);
		expect(isMutationAccepted(deleted.status, deleted.body)).toBe(true);
	});

	test("rejects a refusal wearing a 200", () => {
		const refused = mutations.refusedResponse;
		expect(isMutationAccepted(refused.status, refused.body)).toBe(false);
	});

	test("rejects error statuses and unreadable bodies", () => {
		expect(isMutationAccepted(403, '{"data":{}}')).toBe(false);
		expect(isMutationAccepted(500, "")).toBe(false);
		expect(isMutationAccepted(200, "<html>rate limited</html>")).toBe(false);
	});
});

describe("readTimelinePage", () => {
	test("reads ids and the bottom cursor from bookmark_timeline_v2", () => {
		const page = readTimelinePage(timelinePage, SHAPE);
		expect(page.items).toBe(2);
		expect(page.ids).toEqual([
			"1900000000000000001",
			"1900000000000000002",
		]);
		expect(page.cursor).toBe("DAABCgABGf__page-two");
	});

	test("reads the older bookmark_timeline shape the same way", () => {
		const page = readTimelinePage(legacyPage, SHAPE);
		expect(page.items).toBe(1);
		expect(page.ids).toEqual(["1800000000000000007"]);
		expect(page.cursor).toBe("DAABCgABGf__legacy-two");
	});

	test("an unrecognised payload is an empty page, not a throw", () => {
		expect(readTimelinePage({ data: {} }, SHAPE)).toEqual({
			cursor: null,
			items: 0,
			ids: [],
		});
		expect(readTimelinePage(null, SHAPE).items).toBe(0);
	});

	test("a cursor entry is never counted as an item", () => {
		const page = readTimelinePage(
			{
				data: {
					bookmark_timeline_v2: {
						timeline: {
							instructions: [
								{
									entries: [
										{
											entryId: "cursor-bottom-0",
											content: { value: "next" },
										},
									],
								},
							],
						},
					},
				},
			},
			SHAPE,
		);
		expect(page).toEqual({ cursor: "next", items: 0, ids: [] });
	});
});

describe("readRequestTemplate", () => {
	const observed = mutations.timelineRequestUrl;

	test("keeps the feature set X actually sent", () => {
		const template = readRequestTemplate(observed, "Bookmarks");
		expect(template).not.toBeNull();
		expect(template?.queryId).toBe("Xxk9nWFcNy1qWJgYFBQZ3g");
		expect(template?.features).toContain("graphql_timeline_v2_bookmark_timeline");
		expect(template?.fieldToggles).toContain("withArticlePlainText");
	});

	test("drops the cursor, because that belongs to one page", () => {
		const template = readRequestTemplate(observed, "Bookmarks");
		expect(template?.variables).toEqual({
			count: 100,
			includePromotedContent: false,
		});
	});

	test("carries no header, credential or cookie field at all", () => {
		const template = readRequestTemplate(observed, "Bookmarks");
		const serialized = JSON.stringify(template).toLowerCase();
		for (const forbidden of [
			"authorization",
			"bearer",
			"cookie",
			"csrf",
			"ct0",
			"token",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(Object.keys(template ?? {}).sort()).toEqual([
			"features",
			"fieldToggles",
			"operation",
			"queryId",
			"variables",
		]);
	});

	test("refuses anything that is not an x.com graphql request", () => {
		expect(readRequestTemplate(observed, "Bookmarks")).not.toBeNull();
		expect(readRequestTemplate(observed, "SomethingElse")).toBeNull();
		expect(
			readRequestTemplate(
				"https://evil.example/i/api/graphql/abcdef/Bookmarks?variables=%7B%7D",
				"Bookmarks",
			),
		).toBeNull();
		expect(
			readRequestTemplate(
				"http://x.com/i/api/graphql/abcdef/Bookmarks?variables=%7B%7D",
				"Bookmarks",
			),
		).toBeNull();
		expect(
			readRequestTemplate("https://x.com/i/bookmarks", "Bookmarks"),
		).toBeNull();
		expect(
			readRequestTemplate(
				"https://x.com/i/api/graphql/abcdef/Bookmarks?variables=notjson",
				"Bookmarks",
			),
		).toBeNull();
	});

	test("rebuilds a page URL from the template and a cursor", () => {
		const template = readRequestTemplate(observed, "Bookmarks");
		if (!template) throw new Error("expected a template");

		const first = new URL(buildTimelineUrl(template, null));
		expect(first.pathname).toBe(
			"/i/api/graphql/Xxk9nWFcNy1qWJgYFBQZ3g/Bookmarks",
		);
		expect(JSON.parse(first.searchParams.get("variables") ?? "")).toEqual({
			count: 100,
			includePromotedContent: false,
		});

		const second = new URL(buildTimelineUrl(template, "DAABCgABGf__page-two"));
		expect(JSON.parse(second.searchParams.get("variables") ?? "")).toEqual({
			count: 100,
			includePromotedContent: false,
			cursor: "DAABCgABGf__page-two",
		});
		expect(second.searchParams.get("features")).toBe(template.features);
	});
});

describe("shouldStopImport", () => {
	const base = {
		page: 1,
		pageLimit: 40,
		items: 20,
		cursor: "next",
		previousCursor: null,
	};

	test("keeps walking while pages are full and the cursor moves", () => {
		expect(shouldStopImport(base)).toEqual({
			stop: false,
			reason: null,
			knownStreak: 0,
		});
	});

	test("stops on an empty page", () => {
		expect(shouldStopImport({ ...base, items: 0 }).reason).toBe("empty_page");
	});

	test("stops when the cursor stops moving", () => {
		expect(
			shouldStopImport({ ...base, cursor: "same", previousCursor: "same" })
				.reason,
		).toBe("repeated_cursor");
		expect(shouldStopImport({ ...base, cursor: null }).reason).toBe(
			"no_cursor",
		);
	});

	test("stops at the page limit", () => {
		expect(shouldStopImport({ ...base, page: 40 }).reason).toBe("page_limit");
	});

	test("an incremental run stops once enough known items pile up", () => {
		const first = shouldStopImport({
			...base,
			items: 20,
			knownOnPage: 20,
			overlapThreshold: 30,
		});
		expect(first.stop).toBe(false);
		expect(first.knownStreak).toBe(20);

		const second = shouldStopImport({
			...base,
			page: 2,
			items: 20,
			knownOnPage: 20,
			knownStreak: first.knownStreak,
			overlapThreshold: 30,
		});
		expect(second.stop).toBe(true);
		expect(second.reason).toBe("known_overlap");
	});

	test("one new item resets the streak, so nothing is skipped", () => {
		const decision = shouldStopImport({
			...base,
			items: 20,
			knownOnPage: 19,
			knownStreak: 40,
			overlapThreshold: 30,
		});
		expect(decision.stop).toBe(false);
		expect(decision.knownStreak).toBe(0);
	});

	test("an initial import never stops on overlap", () => {
		expect(
			shouldStopImport({ ...base, knownOnPage: 20, overlapThreshold: 0 }).stop,
		).toBe(false);
	});
});

describe("tweetUrl", () => {
	test("uses the handle when there is a usable one", () => {
		expect(tweetUrl("1900000000000000001", "anansi_dev")).toBe(
			"https://x.com/anansi_dev/status/1900000000000000001",
		);
	});

	test("falls back to the form X itself redirects", () => {
		expect(tweetUrl("1900000000000000001")).toBe(
			"https://x.com/i/status/1900000000000000001",
		);
		expect(tweetUrl("1900000000000000001", "not a handle!")).toBe(
			"https://x.com/i/status/1900000000000000001",
		);
	});
});
