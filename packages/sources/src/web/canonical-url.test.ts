import { describe, expect, test } from "bun:test";
import { canonicalizeWebUrl, webExternalId } from "./canonical-url.ts";

describe("canonicalizeWebUrl", () => {
	test("normalizes host, default port, fragment, and query order", () => {
		expect(
			canonicalizeWebUrl("HTTPS://Example.COM:443/read?z=2&a=1#comments"),
		).toBe("https://example.com/read?a=1&z=2");
	});

	test("removes only known tracking parameters", () => {
		expect(
			canonicalizeWebUrl(
				"https://example.com/item?id=42&utm_source=x&fbclid=abc&view=full&msclkid=def",
			),
		).toBe("https://example.com/item?id=42&view=full");
	});

	test("preserves duplicate and application-significant parameters", () => {
		expect(
			canonicalizeWebUrl("https://example.com/search?tag=b&tag=a&page=2"),
		).toBe("https://example.com/search?page=2&tag=b&tag=a");
	});

	test("uses a same-origin canonical candidate, including a relative one", () => {
		expect(
			canonicalizeWebUrl(
				"https://example.com/article?utm_source=newsletter",
				"/canonical/article",
			),
		).toBe("https://example.com/canonical/article");
	});

	test("ignores a cross-origin canonical candidate", () => {
		expect(
			canonicalizeWebUrl(
				"https://example.com/article?id=7",
				"https://tracker.test/article",
			),
		).toBe("https://example.com/article?id=7");
	});

	test("rejects browser, file, script, credential, and malformed URLs", () => {
		expect(canonicalizeWebUrl("chrome://extensions")).toBeNull();
		expect(canonicalizeWebUrl("file:///C:/private.txt")).toBeNull();
		expect(canonicalizeWebUrl("javascript:alert(1)")).toBeNull();
		expect(
			canonicalizeWebUrl("https://user:pass@example.com/private"),
		).toBeNull();
		expect(canonicalizeWebUrl("not a url")).toBeNull();
	});
});

describe("webExternalId", () => {
	test("is deterministic and changes with meaningful URL identity", async () => {
		const first = await webExternalId("https://example.com/article?id=1");
		const again = await webExternalId("https://example.com/article?id=1");
		const other = await webExternalId("https://example.com/article?id=2");

		expect(first).toBe(again);
		expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(other).not.toBe(first);
	});
});
