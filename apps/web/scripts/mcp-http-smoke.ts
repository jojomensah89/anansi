/**
 * Drives /mcp over real HTTP the way a remote agent would.
 *
 * This is the path the spec calls the reason the migration is worth doing:
 * "a remote MCP server is a URL someone else can connect their own agent to,
 * with nothing to install." Until this passes, that sentence is a plan.
 */
const base = process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp";
const token = process.env.MCP_TOKEN ?? "dev-mcp";

let id = 0;
async function rpc(method: string, params?: unknown, auth = token) {
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Streamable HTTP requires the client to accept both.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  // A Streamable HTTP reply may be SSE framed; take the last data: line.
  const line = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5).trim()
    : text;
  return { status: res.status, json: JSON.parse(line) };
}

const fail = (m: string) => { console.error("FAIL " + m); process.exitCode = 1; };

const unauth = await rpc("initialize", {}, "wrong-token");
console.log("bad token ->", unauth.status);
if (unauth.status !== 401) fail("a wrong bearer should be rejected");

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "http-smoke", version: "1" },
});
console.log("initialize ->", init.status, init.json?.result?.serverInfo?.name);
if (init.status !== 200) fail("initialize");

const list = await rpc("tools/list");
const tools = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
console.log("tools ->", tools.join(", "));
for (const want of ["search_memory", "get_item", "recent_saves", "find_by_author"]) {
  if (!tools.includes(want)) fail("missing " + want);
}

const search = await rpc("tools/call", {
  name: "search_memory",
  arguments: { query: "phone farm", limit: 1 },
});
const payload = JSON.parse(search.json?.result?.content?.[0]?.text ?? "{}");
console.log("search_memory ->", payload.count, "result(s)");
if (!payload.count) fail("search over http returned nothing");

const first = payload.results?.[0];
if (first) {
  const item = await rpc("tools/call", { name: "get_item", arguments: { id: first.id } });
  const detail = JSON.parse(item.json?.result?.content?.[0]?.text ?? "{}");
  console.log(`get_item -> @${detail.author} · ${detail.links?.length ?? 0} links`);
  if ("raw" in detail) fail("raw leaked over http");
}

console.log(process.exitCode ? "http smoke FAILED" : "http smoke ok");
