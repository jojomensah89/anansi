import { describe, expect, test } from "bun:test";
import {
	MESSAGE_PROTOCOL_VERSION,
	type MessageContext,
	parseExtensionMessage,
} from "./messages.ts";

const NONCE = "tab_nonce_0123456789abcdef";

const pageContext = (url: string): MessageContext => ({
	path: "page-to-relay",
	pageUrl: url,
	expectedNonce: NONCE,
});

const tabRuntimeContext = (url: string): MessageContext => ({
	path: "runtime-to-background",
	sender: { kind: "tab", url },
	expectedNonce: NONCE,
});

const extensionRuntimeContext: MessageContext = {
	path: "runtime-to-background",
	sender: { kind: "extension" },
};

const pageEvent = (
	source: "x" | "reddit" | "tiktok" | "github",
	action: string,
) => ({
	anansi: "page-event",
	messageVersion: MESSAGE_PROTOCOL_VERSION,
	source,
	nonce: NONCE,
	action,
});

describe("parseExtensionMessage", () => {
	test.each([
		["https://x.com/i/bookmarks", pageEvent("x", "saved")],
		["https://twitter.com/i/bookmarks", pageEvent("x", "saved")],
		["https://www.reddit.com/user/example/saved", pageEvent("reddit", "saved")],
		["https://old.reddit.com/user/example/saved", pageEvent("reddit", "saved")],
		["https://reddit.com/user/example/saved", pageEvent("reddit", "saved")],
		[
			"https://www.tiktok.com/@example/favorites",
			{
				...pageEvent("tiktok", "observed"),
				operation: "/api/user/collect/item_list/",
				raw: { itemList: [] },
				items: 0,
			},
		],
		["https://tiktok.com/@example/favorites", pageEvent("tiktok", "scanned")],
		[
			"https://github.com/stars",
			{
				...pageEvent("github", "page"),
				page: 1,
				items: 1,
				cursor: "https://github.com/stars?after=cursor_2",
				raw: {
					schemaVersion: 1,
					pageType: "github_stars",
					repositories: [],
				},
			},
		],
	])("accepts the expected message family for %s", (url, message) => {
		const result = parseExtensionMessage(message, pageContext(url));

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.source).toBe(message.source);
	});

	test("accepts a relayed page event in the background and derives its source", () => {
		const result = parseExtensionMessage(
			{
				...pageEvent("reddit", "page"),
				page: 1,
				items: 2,
				raw: { data: { children: [] } },
			},
			tabRuntimeContext("https://www.reddit.com/user/example/saved"),
		);

		expect(result).toMatchObject({
			ok: true,
			path: "runtime-to-background",
			source: "reddit",
		});
	});

	test.each([
		{ ...pageEvent("x", "saved"), anansi: "mystery" },
		{ ...pageEvent("x", "saved"), source: "instagram" },
		{ ...pageEvent("x", "mystery") },
		{ ...pageEvent("x", "saved"), messageVersion: 99 },
	])("rejects unknown names, sources, actions, and versions", (message) => {
		expect(
			parseExtensionMessage(message, pageContext("https://x.com/i/bookmarks"))
				.ok,
		).toBe(false);
	});

	test("rejects a claimed source that does not match the page URL", () => {
		const result = parseExtensionMessage(
			pageEvent("tiktok", "scanned"),
			pageContext("https://www.reddit.com/user/example/saved"),
		);

		expect(result).toEqual({
			ok: false,
			error: {
				code: "source_mismatch",
				message: "message source does not match the verified page",
			},
		});
	});

	test("rejects spoofed and unsupported origins", () => {
		expect(
			parseExtensionMessage(
				pageEvent("x", "saved"),
				pageContext("https://x.com.evil.test/i/bookmarks"),
			),
		).toMatchObject({ ok: false, error: { code: "origin_not_allowed" } });
		expect(
			parseExtensionMessage(
				pageEvent("x", "saved"),
				pageContext("http://x.com/i/bookmarks"),
			),
		).toMatchObject({ ok: false, error: { code: "origin_not_allowed" } });
	});

	test("rejects page commands on the page-to-extension path", () => {
		const result = parseExtensionMessage(
			{
				anansi: "page-command",
				messageVersion: MESSAGE_PROTOCOL_VERSION,
				source: "x",
				nonce: NONCE,
				action: "configure",
				config: { operation: "Bookmarks" },
			},
			pageContext("https://x.com/i/bookmarks"),
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "direction_mismatch" },
		});
	});

	test("accepts relay-to-page commands only for the matching source and nonce", () => {
		const context: MessageContext = {
			path: "relay-to-page",
			pageUrl: "https://www.tiktok.com/@example/favorites",
			expectedNonce: NONCE,
		};
		const result = parseExtensionMessage(
			{
				anansi: "page-command",
				messageVersion: MESSAGE_PROTOCOL_VERSION,
				source: "tiktok",
				nonce: NONCE,
				action: "scan",
				config: { watchUrls: ["/api/user/collect/item_list/"] },
			},
			context,
		);

		expect(result).toMatchObject({
			ok: true,
			path: "relay-to-page",
			source: "tiktok",
		});
	});

	test("accepts GitHub backfill commands and stable extraction errors", () => {
		const context: MessageContext = {
			path: "relay-to-page",
			pageUrl: "https://github.com/stars",
			expectedNonce: NONCE,
		};
		expect(
			parseExtensionMessage(
				{
					anansi: "page-command",
					messageVersion: MESSAGE_PROTOCOL_VERSION,
					source: "github",
					nonce: NONCE,
					action: "backfill",
					config: { source: "github", pageLimit: 40 },
				},
				context,
			),
		).toMatchObject({ ok: true, source: "github" });

		for (const errorCode of ["page_shape_changed", "rate_limited"]) {
			expect(
				parseExtensionMessage(
					{ ...pageEvent("github", "error"), errorCode },
					pageContext("https://github.com/stars"),
				),
			).toMatchObject({ ok: true, source: "github" });
		}
	});

	test("rejects an incorrect page correlation nonce", () => {
		const result = parseExtensionMessage(
			{ ...pageEvent("x", "saved"), nonce: "another_nonce_0123456789" },
			pageContext("https://x.com/i/bookmarks"),
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "nonce_mismatch" },
		});
	});

	test("accepts extension popup commands and rejects them from tabs", () => {
		const popup = {
			anansi: "popup-command",
			messageVersion: MESSAGE_PROTOCOL_VERSION,
			action: "start",
			source: "reddit",
		};

		expect(parseExtensionMessage(popup, extensionRuntimeContext)).toMatchObject(
			{
				ok: true,
				path: "runtime-to-background",
				source: "reddit",
			},
		);
		expect(
			parseExtensionMessage(
				popup,
				tabRuntimeContext("https://www.reddit.com/user/example/saved"),
			),
		).toMatchObject({ ok: false, error: { code: "direction_mismatch" } });
	});

	test("rejects page events presented as extension popup messages", () => {
		expect(
			parseExtensionMessage(pageEvent("x", "saved"), extensionRuntimeContext),
		).toMatchObject({
			ok: false,
			error: { code: "direction_mismatch" },
		});
	});

	test("enforces serialized byte limits", () => {
		const marker = "PRIVATE-MARKER-DO-NOT-REFLECT";
		const result = parseExtensionMessage(
			{
				...pageEvent("x", "page"),
				page: 1,
				items: 1,
				raw: { body: marker.repeat(20) },
			},
			pageContext("https://x.com/i/bookmarks"),
			{ maxPayloadBytes: 120 },
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "payload_too_large" },
		});
		if (!result.ok) expect(result.error.message).not.toContain(marker);
	});

	test("enforces structural depth and node limits", () => {
		const deep = { child: { child: { child: { child: true } } } };
		const wide = { values: [{}, {}, {}, {}] };
		const message = { ...pageEvent("x", "page"), page: 1, items: 1 };

		expect(
			parseExtensionMessage(
				{ ...message, raw: deep },
				pageContext("https://x.com/i/bookmarks"),
				{
					maxDepth: 3,
				},
			),
		).toMatchObject({ ok: false, error: { code: "payload_too_complex" } });
		expect(
			parseExtensionMessage(
				{ ...message, raw: wide },
				pageContext("https://x.com/i/bookmarks"),
				{
					maxNodes: 4,
				},
			),
		).toMatchObject({ ok: false, error: { code: "payload_too_complex" } });
	});

	test("never reflects raw input in validation errors", () => {
		const marker = "raw-secret-<script>alert(1)</script>";
		const failures = [
			parseExtensionMessage(
				{ anansi: marker },
				pageContext("https://x.com/i/bookmarks"),
			),
			parseExtensionMessage(
				{ ...pageEvent("x", "page"), page: marker, items: 0, raw: {} },
				pageContext("https://x.com/i/bookmarks"),
			),
			parseExtensionMessage(
				{
					anansi: "page-command",
					messageVersion: MESSAGE_PROTOCOL_VERSION,
					source: "x",
					nonce: NONCE,
					action: "configure",
					config: { authorization: marker },
				},
				{
					path: "relay-to-page",
					pageUrl: "https://x.com/i/bookmarks",
					expectedNonce: NONCE,
				},
			),
		];

		for (const result of failures) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).not.toContain(marker);
		}
	});

	describe("bookmark mutations", () => {
		const bookmark = (patch: Record<string, unknown>) => ({
			...pageEvent("x", "bookmark"),
			bookmarkAction: "save",
			externalId: "1900000000000000001",
			...patch,
		});

		test("accepts an explicit save and an explicit unsave", () => {
			for (const action of ["save", "unsave"]) {
				const result = parseExtensionMessage(
					bookmark({ bookmarkAction: action }),
					pageContext("https://x.com/i/bookmarks"),
				);
				expect(result.ok).toBe(true);
			}
		});

		test("rejects an unknown action, a bad id and unknown fields", () => {
			const rejected = [
				bookmark({ bookmarkAction: "delete" }),
				bookmark({ externalId: "../../etc/passwd" }),
				bookmark({ externalId: "" }),
				bookmark({ note: "anything" }),
			];
			for (const message of rejected) {
				expect(
					parseExtensionMessage(
						message,
						pageContext("https://x.com/i/bookmarks"),
					).ok,
				).toBe(false);
			}
		});

		test("Reddit carries the permalink its fullname cannot express", () => {
			const result = parseExtensionMessage(
				{
					...pageEvent("reddit", "bookmark"),
					bookmarkAction: "unsave",
					externalId: "t1_9zyxwv",
					canonicalUrl:
						"https://www.reddit.com/r/programming/comments/1abcdef/x/9zyxwv/",
					raw: { data: { children: [] } },
				},
				pageContext("https://www.reddit.com/user/example/saved"),
			);
			expect(result.ok).toBe(true);
		});

		test("accepts a GitHub repository identity only on GitHub", () => {
			const githubBookmark = {
				...pageEvent("github", "bookmark"),
				bookmarkAction: "unsave",
				externalId: "vyom-26/bmx_racer",
				canonicalUrl: "https://github.com/Vyom-26/BMX_Racer",
			};
			expect(
				parseExtensionMessage(
					githubBookmark,
					pageContext("https://github.com/Vyom-26/BMX_Racer"),
				),
			).toMatchObject({ ok: true, source: "github" });
			expect(
				parseExtensionMessage(
					{ ...githubBookmark, externalId: "profile-only" },
					pageContext("https://github.com/stars"),
				).ok,
			).toBe(false);
		});

		test("refuses a link that points off the platform it came from", () => {
			const offPlatform = [
				"https://evil.example/phish",
				"http://x.com/i/status/1900000000000000001",
				"https://www.reddit.com/r/programming/",
			];
			for (const canonicalUrl of offPlatform) {
				expect(
					parseExtensionMessage(
						bookmark({ canonicalUrl }),
						pageContext("https://x.com/i/bookmarks"),
					).ok,
				).toBe(false);
			}
		});
	});
});
