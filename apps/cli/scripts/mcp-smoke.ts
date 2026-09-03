/**
 * Drives `anansi serve --mcp` over real stdio JSON-RPC, the way a client does.
 *
 * Worth having as a script rather than a unit test: almost everything that
 * breaks an MCP server is in the transport, not the handlers — a stray write
 * to stdout, a tool that throws on hostile input, a schema the client rejects.
 * None of that shows up when you call the functions directly.
 *
 *   bun run apps/cli/scripts/mcp-smoke.ts
 */
const proc = Bun.spawn(["bun", "run", "apps/cli/src/cli.ts", "serve", "--mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + "\n");
const call = (id: number, name: string, args: unknown) =>
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
call(3, "search_memory", { query: "ai sdk artifacts", limit: 2 });
call(4, "find_by_author", { handle: "@pontusab", limit: 2 });
call(5, "recent_saves", { limit: 2 });
// Every one of these throws if bound raw into an FTS5 match.
call(6, "search_memory", { query: "it's a * mess (unbalanced AND", limit: 2 });
await proc.stdin.flush();

const seen = new Map<number, any>();
const reader = proc.stdout.getReader();
const dec = new TextDecoder();
let buf = "";
let chained = false;
const deadline = Date.now() + 25_000;

while (Date.now() < deadline && !seen.has(7)) {
  const r = await Promise.race([
    reader.read(),
    new Promise<{ value?: Uint8Array; done?: boolean }>((res) =>
      setTimeout(() => res({ value: undefined }), 1200)),
  ]);
  if (r.done) break;
  if (r.value) {
    buf += dec.decode(r.value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id) seen.set(msg.id, msg);
      } catch {
        console.error("NOT JSON on stdout — something wrote to the RPC channel:", line.slice(0, 120));
        process.exitCode = 1;
      }
    }
  }
  // get_item is only meaningful on an id search actually returned.
  if (!chained && seen.has(3)) {
    chained = true;
    const first = JSON.parse(seen.get(3).result.content[0].text).results[0];
    call(7, "get_item", { id: first.id });
    await proc.stdin.flush();
  }
}
proc.kill();

const body = (id: number) => JSON.parse(seen.get(id).result.content[0].text);
const fail = (msg: string) => {
  console.error("FAIL " + msg);
  process.exitCode = 1;
};

const tools = (seen.get(2)?.result?.tools ?? []).map((t: any) => t.name);
console.log("tools:", tools.join(", "));
for (const want of ["search_memory", "get_item", "recent_saves", "find_by_author"]) {
  if (!tools.includes(want)) fail("missing tool " + want);
}

if (body(3).count === 0) fail("search_memory found nothing");
if (body(4).count === 0) fail("find_by_author found nothing");
if (body(5).count === 0) fail("recent_saves found nothing");
if (seen.get(6)?.error) fail("hostile query threw instead of returning nothing");

const item = body(7);
console.log(
  `get_item: @${item.author} · ${item.media.length} media · ${item.links.length} links · ${item.thread.length} thread`,
);
if ("raw" in item) fail("get_item leaked the raw payload into agent context");
if (!item.url) fail("get_item returned no url");

console.log(process.exitCode ? "smoke FAILED" : "smoke ok");
