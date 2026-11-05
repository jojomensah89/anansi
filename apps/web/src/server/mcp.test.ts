import { describe, expect, test } from "bun:test";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { resolveServerCredentials } from "./credentials.ts";
import { handleMcp } from "./mcp.ts";

const local = openLocalDb(":memory:");
migrateLocalDb(local);
const db = local as unknown as AnansiDb;
const credentials = resolveServerCredentials({
  ANANSI_SECRET: "test-shared-secret",
  LIBRARY_TOKEN: "test-library-secret",
  INGEST_TOKEN: "test-ingest-secret",
  MCP_TOKEN: "test-mcp-secret",
});

const request = (authorization?: string) => new Request("https://anansi.test/mcp", {
  method: "POST",
  headers: {
    ...(authorization ? { authorization } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auth-test", version: "1.0.0" },
    },
  }),
});

describe("MCP HTTP authentication", () => {
  test("fails closed when no MCP credential is configured", async () => {
    expect((await handleMcp({ db }, request())).status).toBe(503);
    expect((await handleMcp({ db, token: "  " }, request())).status).toBe(503);
  });

  test("the ingest credential cannot authorize MCP when role credentials differ", async () => {
    const response = await handleMcp({ db, token: credentials.mcpToken }, request(`Bearer ${credentials.ingestToken}`));
    expect(response.status).toBe(401);
  });

  test("accepts the configured MCP credential", async () => {
    const response = await handleMcp({ db, token: credentials.mcpToken }, request(`Bearer ${credentials.mcpToken}`));
    expect(response.status).not.toBe(401);
  });
});
