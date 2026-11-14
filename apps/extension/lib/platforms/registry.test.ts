import { describe, expect, test } from "bun:test";
import { PLATFORM_CAPTURE_ADAPTERS, captureAdapter, captureSourceFromUrl, isExpectedPlatformImportTab, isPlatformExternalId, isPlatformSourceUrl, platformCanonicalUrl } from "./registry.ts";

describe("platform capture adapter registry", () => {
	test("statically registers every extension platform with its import strategy", () => {
		expect(Object.keys(PLATFORM_CAPTURE_ADAPTERS)).toEqual(["x", "reddit", "github", "tiktok"]);
		expect(Object.values(PLATFORM_CAPTURE_ADAPTERS).map((adapter) => adapter.importMode)).toEqual(["page", "session", "session", "page"]);
	});

	test("derives secure page origins and source URLs from adapter host lists", () => {
		expect(captureSourceFromUrl("https://twitter.com/home")).toBe("x");
		expect(captureSourceFromUrl("https://old.reddit.com/r/test")).toBe("reddit");
		expect(captureSourceFromUrl("https://github.com/stars")).toBe("github");
		expect(captureSourceFromUrl("https://www.tiktok.com/@me")).toBe("tiktok");
		expect(captureSourceFromUrl("http://x.com/home")).toBeNull();
		expect(captureSourceFromUrl("https://evil.example/x.com")).toBeNull();
		expect(isPlatformSourceUrl("https://www.reddit.com/comments/abc", "reddit")).toBe(true);
		expect(isPlatformSourceUrl("http://www.reddit.com/comments/abc", "reddit")).toBe(false);
		expect(isPlatformSourceUrl("https://github.com.evil.example/owner/repo", "github")).toBe(false);
	});

	test("keeps platform identity, canonical links, and expected import-tab policy local", () => {
		expect(isPlatformExternalId("owner/repo", "github")).toBe(true);
		expect(isPlatformExternalId("owner/repo/extra", "github")).toBe(false);
		expect(isPlatformExternalId("t3_abc123", "reddit")).toBe(true);
		expect(platformCanonicalUrl("x", "12345")).toBe("https://x.com/i/status/12345");
		expect(platformCanonicalUrl("reddit", "t3_abc123")).toBe("https://www.reddit.com/comments/abc123");
		expect(platformCanonicalUrl("github", "owner/repo")).toBe("https://github.com/owner/repo");
		expect(platformCanonicalUrl("tiktok", "123456")).toBe("https://www.tiktok.com/video/123456");
		expect(isExpectedPlatformImportTab("x", "https://twitter.com/i/bookmarks")).toBe(true);
		expect(isExpectedPlatformImportTab("reddit", "https://old.reddit.com/user/me/saved/")).toBe(true);
		expect(isExpectedPlatformImportTab("github", "https://github.com/stars")).toBe(true);
		expect(isExpectedPlatformImportTab("tiktok", "https://www.tiktok.com/@me")).toBe(true);
	});

	test("keeps TikTok identity preparation inside its page-import adapter", async () => {
		const calls: string[] = [];
		const adapter = captureAdapter("tiktok");
		const result = await adapter.preparePageImport!({
			setMessage: async (message) => { calls.push(`message:${message}`); },
			identify: async () => { calls.push("identify"); },
			waitForIdentity: async () => "my_handle",
			currentUrl: async () => "https://www.tiktok.com/",
			navigate: async (url) => { calls.push(`navigate:${url}`); return true; },
			configure: async () => { calls.push("configure"); return true; },
		});
		expect(result).toEqual({ ready: true });
		expect(calls).toEqual([
			"message:finding your favorites…",
			"identify",
			"navigate:https://www.tiktok.com/@my_handle",
			"configure",
		]);
	});
});
