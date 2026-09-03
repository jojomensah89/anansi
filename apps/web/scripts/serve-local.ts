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
import { openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { handleApi } from "../src/server/api.ts";
import { handleMcp } from "../src/server/mcp.ts";

const port = Number(process.env.PORT ?? 8788);
const dbPath = process.env.ANANSI_DB_PATH ?? "data/anansi.db";
const ingestToken = process.env.INGEST_TOKEN;
const mcpToken = process.env.MCP_TOKEN;

const db = openLocalDb(dbPath) as unknown as AnansiDb;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);

    // Dev-only CORS. In production the UI is served by the same Worker as the
    // API and none of this exists; here the Vite dev server is on another
    // port, so the browser treats it as cross-origin.
    const cors = {
      "access-control-allow-origin": request.headers.get("origin") ?? "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const response =
      pathname === "/mcp"
        ? await handleMcp({ db, token: mcpToken }, request)
        : pathname.startsWith("/api/")
          ? await handleApi({ db, ingestToken }, request)
          : new Response("anansi local: /api/* and /mcp", { status: 404 });

    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
});

console.log(`anansi local  http://127.0.0.1:${server.port}`);
console.log(`  db      ${dbPath}`);
console.log(`  ingest  ${ingestToken ? "bearer required" : "closed (set INGEST_TOKEN)"}`);
console.log(`  mcp     ${mcpToken ? "bearer required" : "closed (set MCP_TOKEN)"}`);
