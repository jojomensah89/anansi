import { describe, expect, test } from "bun:test";
import fixtures from "../../test/fixtures/reddit/mutations.json" with {
	type: "json",
};
import {
	infoUrl,
	readInfoObject,
	readSaveMutation,
	retryAfterMs,
} from "./reddit.ts";

describe("readSaveMutation", () => {
	test("distinguishes save from unsave", () => {
		const save = fixtures.saveRequest;
		const unsave = fixtures.unsaveRequest;

		expect(readSaveMutation(save.url, save.body)).toEqual({
			action: "save",
			fullname: "t3_1abcdef",
			kind: "post",
		});
		expect(readSaveMutation(unsave.url, unsave.body)).toEqual({
			action: "unsave",
			fullname: "t3_1abcdef",
			kind: "post",
		});
	});

	test("handles comments as well as posts", () => {
		const { url, body } = fixtures.saveCommentRequest;
		expect(readSaveMutation(url, body)).toEqual({
			action: "save",
			fullname: "t1_9zyxwv",
			kind: "comment",
		});
	});

	test("reads the JSON body the newer client sends", () => {
		const { url, body } = fixtures.shredditSaveRequest;
		expect(readSaveMutation(url, body)).toEqual({
			action: "save",
			fullname: "t3_2ghijkl",
			kind: "post",
		});
	});

	test("reads the body shapes fetch and XHR each supply", () => {
		const url = fixtures.saveRequest.url;
		expect(
			readSaveMutation(url, new URLSearchParams({ id: "t3_1abcdef" }))?.action,
		).toBe("save");
		expect(readSaveMutation(url, { id: "t3_1abcdef" })?.action).toBe("save");

		const form = new FormData();
		form.set("id", "t3_1abcdef");
		expect(readSaveMutation(url, form)?.action).toBe("save");
	});

	test("ignores anything that is not a save endpoint", () => {
		const { url, body } = fixtures.unrelatedRequest;
		expect(readSaveMutation(url, body)).toBeNull();
	});

	test("ignores an unusable or absent fullname", () => {
		const url = fixtures.saveRequest.url;
		expect(readSaveMutation(url, "category=&uh=sanitized")).toBeNull();
		expect(readSaveMutation(url, "id=notafullname")).toBeNull();
		// A subreddit or an account is not something this library holds.
		expect(readSaveMutation(url, "id=t5_abcdef")).toBeNull();
		expect(readSaveMutation(url, null)).toBeNull();
	});
});

describe("readInfoObject", () => {
	test("finds a post and its permalink", () => {
		expect(readInfoObject(fixtures.infoListing, "t3_1abcdef")).toEqual({
			fullname: "t3_1abcdef",
			canonicalUrl:
				"https://www.reddit.com/r/programming/comments/1abcdef/a_sanitized_saved_post/",
		});
	});

	test("finds a comment, which has no derivable link without this", () => {
		expect(readInfoObject(fixtures.infoCommentListing, "t1_9zyxwv")).toEqual({
			fullname: "t1_9zyxwv",
			canonicalUrl:
				"https://www.reddit.com/r/programming/comments/1abcdef/a_sanitized_saved_post/9zyxwv/",
		});
	});

	test("returns nothing when the listing is not about that object", () => {
		expect(readInfoObject(fixtures.infoListing, "t3_9999999")).toBeNull();
		expect(readInfoObject({ data: { children: [] } }, "t3_1abcdef")).toBeNull();
		expect(readInfoObject(null, "t3_1abcdef")).toBeNull();
	});

	test("refuses a permalink that points off Reddit", () => {
		const tampered = {
			data: {
				children: [
					{
						data: {
							name: "t3_1abcdef",
							permalink: "https://evil.example/phish",
						},
					},
				],
			},
		};
		expect(readInfoObject(tampered, "t3_1abcdef")).toBeNull();
	});
});

describe("infoUrl", () => {
	test("asks for exactly one object", () => {
		expect(infoUrl("t3_1abcdef")).toBe(
			"https://www.reddit.com/api/info.json?id=t3_1abcdef&raw_json=1",
		);
	});

	test("refuses to build a request out of anything else", () => {
		expect(infoUrl("../../etc")).toBeNull();
		expect(infoUrl("")).toBeNull();
	});
});

describe("retryAfterMs", () => {
	test("honours the header Reddit sends", () => {
		expect(retryAfterMs(429, "30")).toBe(30_000);
	});

	test("falls back when the header is missing or nonsense", () => {
		expect(retryAfterMs(429, null)).toBe(10_000);
		expect(retryAfterMs(429, "soon")).toBe(10_000);
	});

	test("stays inside bounds, so a run can neither spin nor hang", () => {
		expect(retryAfterMs(429, "99999")).toBe(120_000);
		expect(retryAfterMs(429, "0")).toBe(10_000);
	});

	test("is silent about statuses that are not a wait", () => {
		expect(retryAfterMs(200, "30")).toBeNull();
		expect(retryAfterMs(403, "30")).toBeNull();
	});
});
