/**
 * Exercises the local product loop against a fresh SQLite database:
 * authenticated ingest, local Ollama tagging/embedding, FTS5 and semantic
 * search, the extension config contract, and HTTP + stdio MCP.
 *
 * This is intentionally opt-in. It needs a running Ollama daemon with the
 * configured embedding and tag models and never touches data/anansi.db.
 *
 *   bun run e2e:local
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "anansi-e2e-"));
const port = 38_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const dbPath = join(temp, "anansi.db");
const libraryToken = `e2e-library-${crypto.randomUUID()}`;
const ingestToken = `e2e-ingest-${crypto.randomUUID()}`;
const mcpToken = `e2e-mcp-${crypto.randomUUID()}`;
const model = process.env.OLLAMA_EMBEDDING_MODEL ?? "embeddinggemma";
const tagModel = process.env.OLLAMA_TAG_MODEL ?? "qwen3:4b-instruct-2507-q4_K_M";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

const server = Bun.spawn(["bun", "run", "apps/web/scripts/serve-local.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ANANSI_DB_PATH: dbPath,
    ANANSI_MEDIA_DIR: join(temp, "media"),
    LIBRARY_TOKEN: libraryToken,
    INGEST_TOKEN: ingestToken,
    MCP_TOKEN: mcpToken,
    ALLOWED_ORIGINS: base,
    OLLAMA_BASE_URL: ollamaBaseUrl,
    OLLAMA_EMBEDDING_MODEL: model,
    OLLAMA_TAG_MODEL: tagModel,
  },
  stdout: "ignore",
  stderr: "inherit",
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ ...auth(token), "content-type": "application/json" });

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function waitForApi(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error("local API did not start");
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return readJson<T>(await fetch(`${base}${path}`, {
    ...init,
    headers: { ...auth(token), ...(init?.headers ?? {}) },
  }));
}

function sseJson(text: string): any {
  const line = text.split("\n").filter((entry) => entry.startsWith("data:")).at(-1);
  if (!line) throw new Error(`MCP returned no data frame: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice(5).trim());
}

let rpcId = 0;
async function mcpRpc(method: string, params: unknown): Promise<any> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...auth(mcpToken),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`MCP ${method} failed: ${response.status} ${await response.text()}`);
  return sseJson(await response.text());
}

async function stdioSmoke(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "apps/cli/src/cli.ts", "serve", "--mcp"], {
    cwd: root,
    env: { ...process.env, ANANSI_DB_PATH: dbPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const send = async (message: unknown) => { await proc.stdin.write(JSON.stringify(message) + "\n"); };
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "keyword search", source: "web", limit: 5 } } });
    await proc.stdin.flush();

    const seen = new Map<number, any>();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.has(3)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) => setTimeout(() => resolve({ value: undefined }), 500)),
      ]);
      if (result.done) break;
      if (!result.value) continue;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (typeof message.id === "number") seen.set(message.id, message);
      }
    }
    reader.releaseLock();
    if (!seen.get(1)?.result || !seen.get(2)?.result || !seen.get(3)?.result) throw new Error("stdio MCP did not complete initialize/list/search");
    const tools = (seen.get(2).result.tools ?? []).map((tool: { name: string }) => tool.name);
    for (const expected of ["search_memory", "get_item", "recent_saves", "find_by_author"]) {
      if (!tools.includes(expected)) throw new Error(`stdio MCP missing ${expected}`);
    }
    const payload = JSON.parse(seen.get(3).result.content[0].text);
    if (payload.count !== 1) throw new Error(`stdio MCP search returned ${payload.count} rows`);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

try {
  await waitForApi();

  const settings = await api<{ capabilities: { semanticSearch: boolean; autoTagging: boolean } }>("/api/ai", libraryToken);
  if (!settings.capabilities.semanticSearch || !settings.capabilities.autoTagging) throw new Error("local AI capabilities were not advertised");
  await api("/api/ai", libraryToken, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ semanticSearchEnabled: true, autoTaggingEnabled: true }),
  });

  const now = Math.floor(Date.now() / 1_000);
  const capture = {
    schemaVersion: 1,
    payloadType: "item_event",
    eventId: "e2e-local-bookmark",
    source: "web",
    action: "save",
    externalId: "sha256:e2e-local-bookmark",
    canonicalUrl: "https://example.com/anansi-e2e-bookmark",
    observedAt: now,
    captureMethod: "toolbar",
    normalizedItem: {
      source: "web",
      externalId: "sha256:e2e-local-bookmark",
      url: "https://example.com/anansi-e2e-bookmark",
      kind: "article",
      title: "Building dependable MCP bookmark retrieval",
      body: "A practical guide to MCP server tools, SQLite FTS5 BM25 keyword search, semantic retrieval, browser bookmark import, and local-first AI tagging.",
      savedAt: now,
      savedAtIsExact: true,
      metrics: {},
      media: [],
      links: [],
      raw: { synthetic: true },
    },
  };
  const ingest = await api<{ itemId: string; outcome: string }>("/api/ingest", ingestToken, {
    method: "POST",
    headers: { ...jsonHeaders(ingestToken), "idempotency-key": capture.eventId },
    body: JSON.stringify(capture),
  });
  const replay = await api<{ itemId: string; outcome: string }>("/api/ingest", ingestToken, {
    method: "POST",
    headers: { ...jsonHeaders(ingestToken), "idempotency-key": capture.eventId },
    body: JSON.stringify(capture),
  });
  if (replay.itemId !== ingest.itemId) throw new Error("idempotent ingest changed the item id");

  const deadline = Date.now() + 45_000;
  type AiResponse = { progress: { pending: number; failed: number; complete: number } };
  let ai: AiResponse | undefined;
  while (Date.now() < deadline) {
    ai = await api<AiResponse>("/api/ai", libraryToken);
    if (ai.progress.failed > 0) throw new Error(`AI jobs failed: ${JSON.stringify(ai.progress)}`);
    if (ai.progress.pending === 0 && ai.progress.complete >= 2) break;
    await Bun.sleep(500);
  }
  if (!ai || ai.progress.pending !== 0 || ai.progress.complete < 2) throw new Error(`AI jobs did not finish: ${JSON.stringify(ai?.progress)}`);

  const lexical = await api<{ items: Array<{ id: string; tags: Array<{ label: string }> }>; semantic: { applied: boolean } }>("/api/search?q=keyword%20search&limit=5", libraryToken);
  const lexicalHit = lexical.items.find((item) => item.id === ingest.itemId);
  const canonical = new Set(["Web Dev", "AI / ML", "Marketing", "Design", "Startups", "Product", "Career", "DevOps", "Security", "Finance", "Health"]);
  if (!lexicalHit || lexicalHit.tags.length === 0 || lexicalHit.tags.some((tag) => !canonical.has(tag.label))) throw new Error("FTS5 result did not include only canonical AI topics");
  const semantic = await api<{ items: Array<{ id: string }>; semantic: { applied: boolean } }>("/api/search?q=conceptual%20discovery%20from%20saved%20links&limit=5", libraryToken);
  if (!semantic.semantic.applied || !semantic.items.some((item) => item.id === ingest.itemId)) throw new Error("semantic search did not return the synthetic bookmark");

  const config = await api<{ ingest: string; sources: Array<{ source: string }> }>("/api/extension/config", ingestToken);
  if (!config.ingest.endsWith("/api/ingest") || config.sources.length < 3) throw new Error("extension config is incomplete");

  const init = await mcpRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  if (init.result?.serverInfo?.name !== "anansi") throw new Error("HTTP MCP initialize failed");
  const list = await mcpRpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  if (!["search_memory", "get_item", "recent_saves", "find_by_author"].every((name) => names.includes(name))) throw new Error("HTTP MCP tool list is incomplete");
  const search = await mcpRpc("tools/call", { name: "search_memory", arguments: { query: "keyword search", source: "web", limit: 5 } });
  const mcpPayload = JSON.parse(search.result.content[0].text);
  if (mcpPayload.count !== 1 || mcpPayload.results[0].id !== ingest.itemId) throw new Error("HTTP MCP search did not return the ingested bookmark");
  const item = await mcpRpc("tools/call", { name: "get_item", arguments: { id: ingest.itemId } });
  if (JSON.parse(item.result.content[0].text).id !== ingest.itemId) throw new Error("HTTP MCP get_item failed");

  await stdioSmoke();
  console.log(JSON.stringify({
    ok: true,
    itemId: ingest.itemId,
    tags: lexicalHit.tags.map((tag) => tag.label),
    aiProgress: ai.progress,
    semantic: semantic.semantic,
    mcp: { http: true, stdio: true },
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  server.kill();
  await server.exited;
  rmSync(temp, { recursive: true, force: true });
}
