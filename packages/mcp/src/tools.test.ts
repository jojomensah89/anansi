import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AnansiDb, upsertItems } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { createAnansiServer } from "./index.ts";

describe("MCP tool contract", () => {
  test("advertises visible source filters and searches web items", async () => {
    const local = openLocalDb(":memory:");
    migrateLocalDb(local);
    const db = local as unknown as AnansiDb;
    await upsertItems(db, [{
      source: "web",
      externalId: "mcp-web-item",
      url: "https://example.com/mcp-web-item",
      kind: "article",
      title: "MCP source filtering",
      body: "A saved web page for MCP search.",
      savedAt: 1,
      savedAtIsExact: true,
      metrics: {},
      media: [],
      links: [],
      raw: {},
    }]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAnansiServer(db);
    const client = new Client({ name: "mcp-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const search = listed.tools.find((tool) => tool.name === "search_memory");
      const sourceSchema = (search?.inputSchema as { properties?: { source?: { enum?: string[] } } }).properties?.source;
      expect(sourceSchema?.enum).toEqual(["x", "reddit", "github", "web"]);

      const response = await client.callTool({
        name: "search_memory",
        arguments: { query: "source filtering", source: "web", limit: 5 },
      });
      const content = response.content as Array<{ text?: string }>;
      const payload = JSON.parse(String(content[0]?.text));
      expect(payload.count).toBe(1);
      expect(payload.results[0].url).toBe("https://example.com/mcp-web-item");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
