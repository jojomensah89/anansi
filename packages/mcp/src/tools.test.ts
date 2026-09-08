import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { items, type AnansiDb, getItem, upsertItems } from "@anansi/db";
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
    await upsertItems(db, [{
      source: "tiktok",
      externalId: "mcp-hidden-item",
      url: "https://tiktok.example.test/mcp-hidden-item",
      kind: "video",
      title: "Paused hidden source",
      body: "A retained TikTok row that must not be visible to MCP.",
      savedAt: 2,
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

      const hidden = (await db.select({ id: items.id, source: items.source }).from(items)).find(
				(row) => row.source === "tiktok",
			);
      expect(hidden).toBeDefined();
      expect(await getItem(db, hidden!.id)).toBeNull();

      const hiddenSearch = await client.callTool({
        name: "search_memory",
        arguments: { query: "retained TikTok", limit: 5 },
      });
      const hiddenContent = hiddenSearch.content as Array<{ text?: string }>;
      expect(JSON.parse(String(hiddenContent[0]?.text)).count).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
