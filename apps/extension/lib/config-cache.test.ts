import { describe, expect, test } from "bun:test";
import {
	cachedForServer,
	normalizeServerOrigin,
	type ServerCache,
} from "./config-cache.ts";

describe("extension config cache", () => {
	test("normalizes equivalent server addresses to one origin", () => {
		expect(normalizeServerOrigin(" HTTPS://Example.COM:443/path/ ")).toBe(
			"https://example.com",
		);
		expect(normalizeServerOrigin("http://localhost:8788///")).toBe(
			"http://localhost:8788",
		);
	});

	test("rejects unsupported or credential-bearing server addresses", () => {
		expect(normalizeServerOrigin("file:///tmp/anansi")).toBeNull();
		expect(normalizeServerOrigin("https://user:pass@example.com")).toBeNull();
		expect(normalizeServerOrigin("not a url")).toBeNull();
		expect(normalizeServerOrigin("http://anansi.example.com")).toBeNull();
	});

	test("never reuses one server's config for another server", () => {
		const cache: ServerCache<{ version: number }> = {
			serverOrigin: "https://one.example",
			at: 1_000,
			value: { version: 1 },
		};

		expect(
			cachedForServer(cache, "https://one.example/", 1_100, 1_000),
		).toEqual({
			version: 1,
		});
		expect(
			cachedForServer(cache, "https://two.example", 1_100, 1_000),
		).toBeNull();
	});

	test("uses stale fallback only for the same server", () => {
		const cache: ServerCache<string> = {
			serverOrigin: "http://localhost:8788",
			at: 0,
			value: "config-a",
		};

		expect(
			cachedForServer(cache, "http://localhost:8788", 10_000, 1_000),
		).toBeNull();
		expect(
			cachedForServer(cache, "http://localhost:8788", 10_000, 1_000, true),
		).toBe("config-a");
		expect(
			cachedForServer(cache, "http://localhost:9999", 10_000, 1_000, true),
		).toBeNull();
	});
});
