import { describe, expect, test } from "bun:test";
import { parseBookmarkCapture } from "./capture.ts";
import type { NormalizedItem } from "./item.ts";

const item: NormalizedItem = {
	source: "x",
	externalId: "1900000000000000000",
	url: "https://x.com/anansi/status/1900000000000000000",
	kind: "post",
	body: "A useful post",
	savedAt: 1_788_390_000,
	savedAtIsExact: true,
	metrics: {},
	media: [],
	links: [],
	raw: { restId: "1900000000000000000" },
};

const itemEvent = {
	schemaVersion: 1,
	payloadType: "item_event",
	eventId: "event-x-save-1",
	source: "x",
	action: "save",
	externalId: item.externalId,
	canonicalUrl: item.url,
	observedAt: 1_788_390_000,
	captureMethod: "platform_event",
	normalizedItem: item,
};

describe("parseBookmarkCapture", () => {
	test("accepts a precise item event", () => {
		const result = parseBookmarkCapture(itemEvent);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.capture.payloadType).toBe("item_event");
			expect(result.capture.eventId).toBe("event-x-save-1");
		}
	});

	test("accepts a bounded raw import page", () => {
		const result = parseBookmarkCapture({
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "event-x-page-1",
			source: "x",
			action: "snapshot",
			observedAt: 1_788_390_000,
			captureMethod: "platform_import",
			runId: "run-x-1",
			page: 1,
			cursor: "cursor-bottom-1",
			raw: {
				data: { bookmark_timeline_v2: { timeline: { instructions: [] } } },
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok && result.capture.payloadType === "raw_page") {
			expect(result.capture.runId).toBe("run-x-1");
			expect(result.capture.page).toBe(1);
		}
	});

	test("accepts GitHub platform captures and rejects manual capture methods", () => {
		const githubPage = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "event-github-page-1",
			source: "github",
			action: "snapshot",
			observedAt: 1_788_390_000,
			captureMethod: "platform_import",
			runId: "run-github-1",
			page: 1,
			raw: { repositories: [] },
		};

		expect(parseBookmarkCapture(githubPage).ok).toBe(true);
		expect(
			parseBookmarkCapture({ ...githubPage, captureMethod: "toolbar" }).ok,
		).toBe(false);
	});

	test("allows an unsave without item content", () => {
		const { normalizedItem: _, ...withoutItem } = itemEvent;
		const result = parseBookmarkCapture({ ...withoutItem, action: "unsave" });
		expect(result.ok).toBe(true);
	});

	test("rejects unknown schema versions, sources, and actions", () => {
		expect(parseBookmarkCapture({ ...itemEvent, schemaVersion: 2 }).ok).toBe(
			false,
		);
		expect(parseBookmarkCapture({ ...itemEvent, source: "instagram" }).ok).toBe(
			false,
		);
		expect(parseBookmarkCapture({ ...itemEvent, action: "delete" }).ok).toBe(
			false,
		);
	});

	test("rejects an invalid timestamp and malformed raw-page coordinates", () => {
		expect(
			parseBookmarkCapture({ ...itemEvent, observedAt: Number.NaN }).ok,
		).toBe(false);
		expect(
			parseBookmarkCapture({
				schemaVersion: 1,
				payloadType: "raw_page",
				eventId: "event-bad-page",
				source: "reddit",
				action: "snapshot",
				observedAt: 1_788_390_000,
				captureMethod: "platform_import",
				runId: "run-reddit-1",
				page: 0,
				raw: {},
			}).ok,
		).toBe(false);
	});

	test("keeps capture methods paired with their allowed source", () => {
		expect(
			parseBookmarkCapture({ ...itemEvent, captureMethod: "toolbar" }).ok,
		).toBe(false);
		expect(
			parseBookmarkCapture({
				...itemEvent,
				source: "web",
				externalId: "web:1",
				captureMethod: "platform_event",
				normalizedItem: { ...item, source: "web", externalId: "web:1" },
			}).ok,
		).toBe(false);
	});

	test("rejects item identity that disagrees with its envelope", () => {
		const result = parseBookmarkCapture({
			...itemEvent,
			normalizedItem: { ...item, externalId: "another-tweet" },
		});
		expect(result.ok).toBe(false);
	});

	test("rejects malformed normalized metrics, links, and media", () => {
		expect(
			parseBookmarkCapture({
				...itemEvent,
				normalizedItem: { ...item, metrics: { likes: "many" } },
			}).ok,
		).toBe(false);
		expect(
			parseBookmarkCapture({
				...itemEvent,
				normalizedItem: { ...item, links: ["javascript:alert(1)"] },
			}).ok,
		).toBe(false);
		expect(
			parseBookmarkCapture({
				...itemEvent,
				normalizedItem: {
					...item,
					media: [
						{ kind: "executable", originUrl: "https://example.com/file" },
					],
				},
			}).ok,
		).toBe(false);
	});

	test("requires a Chrome bookmark node link for Chrome captures", () => {
		const webItem = {
			...item,
			source: "web",
			externalId: "sha256:web-item",
			url: "https://example.com/article",
			kind: "article",
		} as const;
		const result = parseBookmarkCapture({
			...itemEvent,
			source: "web",
			externalId: webItem.externalId,
			canonicalUrl: webItem.url,
			captureMethod: "chrome_bookmark",
			normalizedItem: webItem,
		});

		expect(result.ok).toBe(false);
	});

	test("rejects oversized payloads", () => {
		const result = parseBookmarkCapture(
			{ ...itemEvent, normalizedItem: { ...item, body: "x".repeat(2_000) } },
			{ maxPayloadBytes: 512 },
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "payload_too_large" },
		});
	});

	test("rejects captures that exceed the object-complexity limit", () => {
		const result = parseBookmarkCapture(itemEvent, { maxObjectNodes: 2 });
		expect(result).toMatchObject({
			ok: false,
			error: { code: "payload_too_large" },
		});
	});

	test("rejects credential-shaped fields without reflecting their value", () => {
		const secret = "Bearer do-not-print-this";
		const result = parseBookmarkCapture({
			...itemEvent,
			normalizedItem: { ...item, raw: { headers: { authorization: secret } } },
		});

		expect(result).toMatchObject({
			ok: false,
			error: { code: "sensitive_field" },
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});
});
