import { strict as assert } from "node:assert";
import { MCP_TOOL_CATALOG } from "@anansi/mcp/catalog";

const origin = "http://127.0.0.1:8787";
const master = "synthetic-local-master-20261014";
const ingest = "synthetic-local-ingest-20261014";
const mcp = "synthetic-local-mcp-20261014";
const checks: string[] = [];
async function request(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return fetch(`${origin}${path}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
}
// This script deliberately knows only synthetic credentials. It cannot modify
// an owner deployment unless the owner deliberately configures those test keys.
assert.equal((await request("/api/items")).status, 401);
assert.equal((await request("/api/items", ingest)).status, 401);
assert.equal((await request("/api/extension/config", master)).status, 401);
checks.push("role isolation on actual Worker HTTP");

const items = Array.from({ length: 15 }, (_, index) => ({
  source: "web", externalId: `local-launch-fixture-${index}`,
  url: `https://example.invalid/anansi-fixture/${index}`, kind: "article",
  title: `Anansi verification reference ${index + 1}`,
  authorHandle: "synthetic-author", authorName: "Synthetic Author",
  body: `Synthetic reference ${index + 1} for verifying Anansi capture, search and library views. No personal data or provider requests.`,
  savedAt: 1791972000 - index, savedAtIsExact: true, saveOrder: 1000 - index,
  metrics: {}, media: [], links: [], raw: {},
}));
const saved = await request("/api/ingest", ingest, { items });
assert.equal(saved.status, 200, `ingest failed: ${await saved.clone().text()}`);
checks.push("actual D1 normalized capture");
const replay = await request("/api/ingest", ingest, { items });
assert.equal(replay.status, 200);
assert.equal((await replay.json() as { inserted: number }).inserted, 0);
checks.push("D1 idempotent replay");

for (const path of ["/api/items?limit=2", "/api/search?q=Synthetic", "/api/creators", "/api/sources", "/api/tags", "/api/collections", "/api/stats", "/api/export"]) {
  const response = await request(path, master);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  await response.json();
}
checks.push("library API and export on real local D1");
const listing = await (await request("/api/items?limit=1", master)).json() as { items: Array<{ id: string }> };
const itemId = listing.items[0]?.id;
assert(itemId);

const args: Record<string, unknown> = {
  search_saved: { query: "Synthetic", limit: 2 }, get_saved: { id: itemId },
  get_saved_many: { ids: [itemId] }, list_saved: { limit: 2 },
  list_recent_saves: { limit: 2 }, list_author_saves: { handle: "synthetic-author", limit: 2 },
  list_tags: {}, library_stats: {},
};
let id = 0;
for (const tool of MCP_TOOL_CATALOG) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool.name, arguments: args[tool.name] } }),
  });
  assert.equal(response.status, 200, tool.name);
  const text = await response.text();
  const json = JSON.parse(text.includes("data:") ? text.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5) : text);
  assert(!json.error && !json.result?.isError, `${tool.name} failed`);
  checks.push(`actual HTTP MCP ${tool.name}`);
}
const scheduled = await fetch(`${origin}/cdn-cgi/local/scheduled?format=json`);
assert.equal(scheduled.status, 200);
assert(scheduled.headers.get("content-type")?.includes("application/json"));
assert.equal((await scheduled.json() as { outcome: string }).outcome, "ok");
checks.push("local Worker scheduled handler");
for (const path of ["/", "/creators", "/sources", "/settings", "/mcp"]) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}
checks.push("all web routes and response headers");
console.log(JSON.stringify({ status: "passed", mode: "local compiled Cloudflare Worker with isolated D1/R2 emulation", checks, limitations: ["No hosted deployment", "No live provider capture", "No AI/Vectorize bindings in this isolated configuration", "Synthetic fixtures remain for browser verification"] }, null, 2));
