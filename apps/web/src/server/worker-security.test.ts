import { describe, expect, test } from "bun:test";
import { limitPublicRequest, secureResponse } from "./worker-security.ts";

describe("public Worker request protection", () => {
  test("separates login, extension and MCP budgets without raw credentials", async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } };
    const env = { LOGIN_RATE_LIMITER: limiter, INGEST_RATE_LIMITER: limiter, MCP_RATE_LIMITER: limiter };
    for (const path of ["/api/auth/session", "/api/ingest", "/api/extension/config", "/mcp/"]) {
      expect(await limitPublicRequest(new Request(`https://library.example${path}`, {
        method: "POST", headers: { "cf-connecting-ip": "192.0.2.1", authorization: "Bearer private-key" },
      }), env)).toBeNull();
    }
    expect(keys).toEqual(["library.example:login:192.0.2.1", "library.example:extension:192.0.2.1", "library.example:extension:192.0.2.1", "library.example:mcp:192.0.2.1"]);
    expect(JSON.stringify(keys)).not.toContain("private-key");
  });
  test("throttling provides a resumable retry and errors fail closed", async () => {
    const request = new Request("https://library.example/api/ingest", { method: "POST" });
    const denied = await limitPublicRequest(request, { INGEST_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("retry-after")).toBe("60");
    expect((await limitPublicRequest(request, {}))?.status).toBe(503);
    expect((await limitPublicRequest(request, { INGEST_RATE_LIMITER: { limit: async () => { throw new Error("outage"); } } }))?.status).toBe(503);
  });
  test("reads, logout and normal navigation do not consume login budget", async () => {
    for (const path of ["/", "/settings", "/api/items", "/api/auth/session", "/mcp"]) {
      expect(await limitPublicRequest(new Request(`https://library.example${path}`), {})).toBeNull();
    }
    expect(await limitPublicRequest(new Request("https://library.example/api/auth/session", { method: "DELETE" }), {})).toBeNull();
    expect(await limitPublicRequest(new Request("https://library.example/mcp", { method: "HEAD" }), {})).toBeNull();
  });
  test("headers apply to errors and immutable responses without dropping cookies", () => {
    const response = secureResponse(new Response("denied", { status: 401, headers: { "set-cookie": "anansi_session=value; HttpOnly" } }));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(secureResponse(Response.redirect("https://library.example")).status).toBe(302);
  });
});
