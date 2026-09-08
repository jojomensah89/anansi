import { describe, expect, test } from "bun:test";
import { type AnansiDb, getItem, items, upsertItems } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnansiServer } from "./index.ts";

describe("MCP tool contract", () => {
	test("advertises visible source filters and searches web items", async () => {
		const local = openLocalDb(":memory:");
		migrateLocalDb(local);
		const db = local as unknown as AnansiDb;
		await upsertItems(db, [
			{
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
			},
		]);
		await upsertItems(db, [
			{
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
			},
		]);

		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const server = createAnansiServer(db);
		const client = new Client({ name: "mcp-test", version: "1" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual([
				"search_saved",
				"get_saved",
				"get_saved_many",
				"list_saved",
				"list_recent_saves",
				"list_author_saves",
				"list_tags",
				"library_stats",
			]);
			const search = listed.tools.find((tool) => tool.name === "search_saved");
			const sourceSchema = search
				? (
						search.inputSchema as {
							properties?: { source?: { enum?: string[] } };
						}
					).properties?.source
				: undefined;
			expect(sourceSchema?.enum).toEqual(["x", "reddit", "github", "web"]);
			const invalidDate = await client.callTool({
				name: "search_saved",
				arguments: { query: "source filtering", since: "2026-02-31" },
			});
			expect(invalidDate.isError).toBe(true);

			const response = await client.callTool({
				name: "search_saved",
				arguments: { query: "source filtering", source: "web", limit: 5 },
			});
			const content = response.content as Array<{ text?: string }>;
			const payload = JSON.parse(String(content[0]?.text));
			expect(payload.count).toBe(1);
			expect(payload.results[0].url).toBe("https://example.com/mcp-web-item");
			const savedId = payload.results[0].id as string;

			const detail = await client.callTool({
				name: "get_saved",
				arguments: { id: savedId },
			});
			expect(
				JSON.parse(
					String((detail.content as Array<{ text?: string }>)[0]?.text),
				),
			).toMatchObject({
				id: savedId,
				url: "https://example.com/mcp-web-item",
			});

			const many = await client.callTool({
				name: "get_saved_many",
				arguments: { ids: [savedId, "missing-id"] },
			});
			expect(
				JSON.parse(String((many.content as Array<{ text?: string }>)[0]?.text)),
			).toMatchObject({
				missing_ids: ["missing-id"],
			});

			for (const name of [
				"list_saved",
				"list_recent_saves",
				"list_author_saves",
				"list_tags",
				"library_stats",
			]) {
				const args = name === "list_author_saves" ? { handle: "unknown" } : {};
				const result = await client.callTool({ name, arguments: args });
				expect(result.isError).not.toBe(true);
				expect(
					(result.content as Array<{ text?: string }>)[0]?.text,
				).toBeDefined();
			}

			const hidden = (
				await db.select({ id: items.id, source: items.source }).from(items)
			).find((row) => row.source === "tiktok");
			expect(hidden).toBeDefined();
			expect(await getItem(db, hidden?.id ?? "")).toBeNull();
			const hiddenBatch = await client.callTool({
				name: "get_saved_many",
				arguments: { ids: [savedId, hidden?.id ?? ""] },
			});
			expect(
				JSON.parse(
					String((hiddenBatch.content as Array<{ text?: string }>)[0]?.text),
				),
			).toMatchObject({ missing_ids: [hidden?.id] });

			const hiddenSearch = await client.callTool({
				name: "search_saved",
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
