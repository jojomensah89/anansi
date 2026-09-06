import { describe, expect, test } from "bun:test";
import { LOCAL_API_ORIGIN, localProxy } from "./vite.config.ts";

describe("local one-origin proxy", () => {
	test("keeps API and MCP paths on the internal Bun server", () => {
		expect(LOCAL_API_ORIGIN).toBe("http://127.0.0.1:8788");
		expect(localProxy).toEqual({
			"/api": { target: LOCAL_API_ORIGIN },
			"/mcp": { target: LOCAL_API_ORIGIN },
		});
		expect(
			Object.values(localProxy).every((rule) => !("rewrite" in rule)),
		).toBe(true);
	});
});
