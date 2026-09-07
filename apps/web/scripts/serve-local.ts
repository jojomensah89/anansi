/**
 * The production handlers, over real HTTP, on Bun.
 *
 * Vite's dev SSR runs under Node, which cannot load `bun:sqlite`, so the
 * TanStack dev server cannot reach the local library. That is a dev-runtime
 * limitation rather than a problem with the code: `handleApi` and `handleMcp`
 * are plain Request -> Response, so mounting them on Bun.serve exercises the
 * genuine article — routing, auth, JSON shapes, and the MCP transport over a
 * real socket.
 *
 * What this does NOT cover is the three-line TanStack wrapper and the D1
 * binding. Those are the only two layers still untested before a deploy.
 */
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { dirname, join } from "node:path";
import { handleApi } from "../src/server/api.ts";
import { fetchPendingMedia } from "../src/server/media.ts";
import { handleMcp } from "../src/server/mcp.ts";
import { createOllamaEmbeddingProvider } from "../src/server/ollama-embedding.ts";
import { createOllamaTaggingProvider, DEFAULT_OLLAMA_TAG_MODEL } from "../src/server/ollama-tagging.ts";
import { openLocalSemanticCache } from "../src/server/local-semantic-cache.ts";
import { createLocalSemanticWorker } from "../src/server/local-semantic-worker.ts";
import { createLocalTaggingWorker } from "../src/server/local-tagging-worker.ts";
import { syncLocalAiModels } from "../src/server/local-ai-settings.ts";

const port = Number(process.env.PORT ?? 8788);
const dbPath = process.env.ANANSI_DB_PATH ?? "data/anansi.db";
const ingestToken = process.env.INGEST_TOKEN;
const mcpToken = process.env.MCP_TOKEN;
const libraryToken = process.env.LIBRARY_TOKEN;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3001,http://127.0.0.1:3001").split(",").map(v=>v.trim()).filter(Boolean);

/**
 * Migrate on open, rather than hoping someone remembered.
 *
 * Opening a library without bringing its schema up to date produces a server
 * that starts cleanly, answers /api/stats correctly, and then fails every
 * ingest with "no such table" — which reads as a broken endpoint rather than
 * an unmigrated database, and sends you looking in the wrong place entirely.
 *
 * Drizzle records what it has applied, so this is a no-op on a current
 * library and additive on an old one.
 */
const local = openLocalDb(dbPath);
migrateLocalDb(local);
const db = local as unknown as AnansiDb;
const mediaDir = process.env.ANANSI_MEDIA_DIR ?? "data/media";
const media = { dir: mediaDir };
const ollamaModel = process.env.OLLAMA_EMBEDDING_MODEL ?? "embeddinggemma";
const ollamaTagModel = process.env.OLLAMA_TAG_MODEL ?? DEFAULT_OLLAMA_TAG_MODEL;
syncLocalAiModels(db, { embeddingModel: ollamaModel, tagModel: ollamaTagModel });
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
try {
  const ollamaHost = new URL(ollamaBaseUrl).hostname.toLowerCase();
  if (!(ollamaHost === "127.0.0.1" || ollamaHost === "localhost" || ollamaHost === "[::1]" || ollamaHost === "::1")) {
    console.warn("  warning: OLLAMA_BASE_URL is not loopback; bookmark text will leave this machine");
  }
} catch {
  // The provider emits the actionable configuration error below.
}
const semanticCachePath = process.env.ANANSI_SEMANTIC_DB_PATH ?? join(dirname(dbPath), "semantic", "ollama.sqlite");
const ollamaProvider = createOllamaEmbeddingProvider({ model: ollamaModel, baseUrl: ollamaBaseUrl });
const ollamaTagger = createOllamaTaggingProvider({ model: ollamaTagModel, baseUrl: ollamaBaseUrl });
const semanticCache = openLocalSemanticCache(semanticCachePath, ollamaModel);
const semanticWorker = createLocalSemanticWorker(db, semanticCache, ollamaProvider);
const taggingWorker = createLocalTaggingWorker(db, ollamaTagger);
const recover = () => fetchPendingMedia(db, media).catch(error => console.error("Media recovery failed:", error));
void recover();
setInterval(() => { void recover(); }, 60_000).unref();
void semanticWorker.runOnce().catch((error) => console.error("Local semantic worker failed:", error));
setInterval(() => { void semanticWorker.runOnce().catch((error) => console.error("Local semantic worker failed:", error)); }, 30_000).unref();
void taggingWorker.runOnce().catch((error) => console.error("Local tagging worker failed:", error));
setInterval(() => { void taggingWorker.runOnce().catch((error) => console.error("Local tagging worker failed:", error)); }, 30_000).unref();

/**
 * A stale server on this port answers with whatever code it was started
 * with, which presents as a 404 on a route you just added. Bun's EADDRINUSE
 * message does not say that, so say it here.
 */
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);

      // Dev-only CORS. In production the UI is served by the same Worker as the
      // API and none of this exists; here the Vite dev server is on another
      // port, so the browser treats it as cross-origin.
      const cors = {
        "access-control-allow-origin": allowedOrigins.includes(request.headers.get("origin") ?? "") ? request.headers.get("origin")! : "",
        "access-control-allow-credentials": "true",
        "vary": "Origin",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });

      const response =
        pathname === "/mcp"
          ? await handleMcp({ db, token: mcpToken }, request)
          : pathname.startsWith("/api/")
            ? await handleApi({ db, media, ingestToken, libraryToken, allowedOrigins, semantic: { provider: ollamaProvider, index: semanticCache, local: true, status: () => semanticWorker.status() }, semanticKick: () => { void semanticWorker.runOnce().catch((error) => console.error("Local semantic worker failed:", error)); }, tagger: ollamaTagger, taggingKick: () => { void taggingWorker.runOnce().catch((error) => console.error("Local tagging worker failed:", error)); } }, request)
            : new Response("anansi local: /api/* and /mcp", { status: 404 });

      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    },
  });

} catch (err) {
  if ((err as { code?: string }).code === "EADDRINUSE") {
    console.error(
      `
  Port ${port} is already in use — an older anansi server is probably still
` +
        `  running there and will answer with its old routes.

` +
        `  Free it:  powershell -c "Get-NetTCPConnection -LocalPort ${port} -State Listen | ` +
        `ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
`,
    );
    process.exit(1);
  }
  throw err;
}

console.log(`anansi local  http://127.0.0.1:${server.port}`);
console.log(`  db      ${dbPath}`);
console.log(`  ingest  ${ingestToken ? "bearer required" : "closed (set INGEST_TOKEN)"}`);
console.log(`  mcp     ${mcpToken ? "bearer required" : "closed (set MCP_TOKEN)"}`);

console.log(`  library ${libraryToken ? "session or bearer required" : "closed (set LIBRARY_TOKEN)"}`);
console.log(`  ollama  ${ollamaModel} via ${ollamaProvider.endpoint}`);
console.log(`  tagging ${ollamaTagModel} via ${ollamaTagger.endpoint}`);
console.log(`  semantic cache ${semanticCachePath}`);
