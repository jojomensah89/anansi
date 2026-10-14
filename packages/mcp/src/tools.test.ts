import { describe, expect, test } from "bun:test";
import {
	setArchived,
	setFavorite,
	tagItems,
	type AnansiDb,
	getItem,
	items,
	upsertItems,
} from "@anansi/db";
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
				externalId: "mcp-tiktok-item",
				url: "https://www.tiktok.com/@example/video/7264315879138020651",
				kind: "video",
				title: "Favorite video",
				body: "A retained TikTok favorite now visible to MCP.",
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
							properties?: {
								source?: {
									enum?: string[];
									anyOf?: Array<{
										enum?: string[];
										items?: { enum?: string[] };
									}>;
								};
								cursor?: unknown;
							};
						}
					).properties?.source
				: undefined;
			const advertisedSources = [
				...(sourceSchema?.enum ?? []),
				...(sourceSchema?.anyOf ?? []).flatMap(
					(option) => option.enum ?? option.items?.enum ?? [],
				),
			];
			expect([...new Set(advertisedSources)]).toEqual([
				"x",
				"reddit",
				"github",
				"tiktok",
				"web",
			]);
			const searchProperties = search?.inputSchema as {
				properties?: { cursor?: unknown; favorite?: unknown; tag?: unknown };
			};
			expect(searchProperties.properties).toMatchObject({
				cursor: expect.any(Object),
				favorite: expect.any(Object),
				tag: expect.any(Object),
			});
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

			const tiktok = (
				await db.select({ id: items.id, source: items.source }).from(items)
			).find((row) => row.source === "tiktok");
			expect(tiktok).toBeDefined();
			expect(await getItem(db, tiktok?.id ?? "")).not.toBeNull();
			const tiktokBatch = await client.callTool({
				name: "get_saved_many",
				arguments: { ids: [savedId, tiktok?.id ?? ""] },
			});
			expect(
				JSON.parse(
					String((tiktokBatch.content as Array<{ text?: string }>)[0]?.text),
				),
			).toMatchObject({ missing_ids: [] });

			const tiktokSearch = await client.callTool({
				name: "search_saved",
				arguments: { query: "retained TikTok", source: "tiktok", limit: 5 },
			});
			const tiktokContent = tiktokSearch.content as Array<{ text?: string }>;
			expect(JSON.parse(String(tiktokContent[0]?.text)).count).toBe(1);
		} finally {
			await client.close();
			await server.close();
		}
	});

	test("search_saved filters results and continues with a relevance cursor", async () => {
		const local = openLocalDb(":memory:");
		migrateLocalDb(local);
		const db = local as unknown as AnansiDb;
		const basePostedAt = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
		await upsertItems(db, [
			{
				source: "web",
				externalId: "mcp-search-alpha",
				url: "https://example.com/mcp-search-alpha",
				kind: "post",
				title: "Staghorn nebula alpha",
				authorHandle: "alice",
				body: "Staghorn nebula searchable item alpha",
				postedAt: basePostedAt + 1,
				savedAt: basePostedAt + 10,
				savedAtIsExact: true,
				metrics: {},
				media: [{ kind: "image", originUrl: "https://cdn.example/alpha.jpg" }],
				links: [],
				raw: {},
			},
			{
				source: "web",
				externalId: "mcp-search-beta",
				url: "https://example.com/mcp-search-beta",
				kind: "post",
				title: "Staghorn nebula beta",
				authorHandle: "bob",
				body: "Staghorn nebula searchable item beta",
				postedAt: basePostedAt + 60 * 60 * 24 * 70,
				savedAt: basePostedAt + 20,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
			{
				source: "github",
				externalId: "mcp-search-gamma",
				url: "https://github.com/example/mcp-search-gamma",
				kind: "repo",
				title: "Staghorn nebula gamma",
				authorHandle: "charlie",
				body: "Staghorn nebula searchable repository gamma",
				postedAt: basePostedAt + 60 * 60 * 24 * 100,
				savedAt: basePostedAt + 30,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
			{
				source: "web",
				externalId: "mcp-search-delta",
				url: "https://example.com/mcp-search-delta",
				kind: "post",
				title: "Staghorn nebula delta",
				authorHandle: "dana",
				body: "Staghorn nebula searchable item delta",
				postedAt: basePostedAt + 60 * 60 * 24 * 130,
				savedAt: basePostedAt + 40,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);

		const rows = await db
			.select({ id: items.id, externalId: items.externalId })
			.from(items);
		const idFor = (externalId: string) =>
			rows.find((row) => row.externalId === externalId)?.id ?? "";
		const alphaId = idFor("mcp-search-alpha");
		const betaId = idFor("mcp-search-beta");
		const gammaId = idFor("mcp-search-gamma");
		const deltaId = idFor("mcp-search-delta");
		await setFavorite(db, [alphaId], true);
		await tagItems(db, [alphaId], "research");
		await setArchived(db, [deltaId], true);
		local.$client.query("UPDATE items SET platform_saved = 0 WHERE id = ?").run(gammaId);

		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const server = createAnansiServer(db);
		const client = new Client({ name: "mcp-search-test", version: "1" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		try {
			const search = async (args: Record<string, unknown>) => {
				const response = await client.callTool({
					name: "search_saved",
					arguments: args,
				});
				expect(response.isError).not.toBe(true);
				return JSON.parse(
					String((response.content as Array<{ text?: string }>)[0]?.text),
				);
			};
			const baseArgs = {
				query: "staghorn nebula",
				source: ["web", "github"],
				limit: 1,
			};
			const first = await search(baseArgs);
			const second = await search({ ...baseArgs, cursor: first.next_cursor });
			const third = await search({ ...baseArgs, cursor: second.next_cursor });
			expect(first.count).toBe(1);
			expect(first.next_cursor).toEqual(expect.any(String));
			expect(second.count).toBe(1);
			expect(second.next_cursor).toEqual(expect.any(String));
			expect(third.count).toBe(1);
			expect(third.next_cursor).toBeNull();
			const pagedIds = [
				first.results[0].id,
				second.results[0].id,
				third.results[0].id,
			];
			expect(new Set(pagedIds).size).toBe(3);
			expect(new Set(pagedIds)).toEqual(new Set([alphaId, betaId, gammaId]));

			const mismatchedCursor = await client.callTool({
				name: "search_saved",
				arguments: {
					query: baseArgs.query,
					source: "web",
					limit: 1,
					cursor: first.next_cursor,
				},
			});
			expect(mismatchedCursor.isError).toBe(true);

			expect((await search({ query: baseArgs.query, source: "github" })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([gammaId]);
			expect((await search({ query: baseArgs.query, author: ["alice", "charlie"] })).results.map(
				(item: { id: string }) => item.id,
			).sort()).toEqual([alphaId, gammaId].sort());
			expect((await search({ query: baseArgs.query, tag: "research" })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([alphaId]);
			expect((await search({ query: baseArgs.query, media: "image" })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([alphaId]);
			expect((await search({ query: baseArgs.query, content_type: "repo" })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([gammaId]);
			expect((await search({ query: baseArgs.query, favorite: true })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([alphaId]);
			expect((await search({ query: baseArgs.query, archived: true })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([deltaId]);
			expect((await search({ query: baseArgs.query, removed: "only" })).results.map(
				(item: { id: string }) => item.id,
			)).toEqual([gammaId]);
			expect((await search({ query: baseArgs.query, since: "2026-03-01" })).results.map(
				(item: { id: string }) => item.id,
			).sort()).toEqual([betaId, gammaId].sort());
		} finally {
			await client.close();
			await server.close();
		}
	});
});
