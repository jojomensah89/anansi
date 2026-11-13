import { describe, expect, test } from "bun:test";
import { changeShelfItems, createShelf, items, tagItems, upsertItems, type AnansiDb } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnansiServer } from "./index.ts";

const save = (externalId: string, body: string) => ({
	source: "web" as const, externalId, url: `https://example.com/${externalId}`, kind: "article",
	title: externalId, body, savedAt: 10, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {},
});

describe("MCP shelves", () => {
	test("list_shelves reports counts and list_saved / search_saved take a shelf", async () => {
		const local = openLocalDb(":memory:");
		migrateLocalDb(local);
		const db = local as unknown as AnansiDb;
		await upsertItems(db, [save("one", "shelfword alpha"), save("two", "shelfword beta"), save("three", "shelfword gamma")]);
		const ids = await db.select({ id: items.id, external_id: items.externalId }).from(items);
		const id = (external: string) => ids.find((row) => row.external_id === external)!.id;
		await tagItems(db, [id("one")], "reading");
		const ruled = await createShelf(db, { name: "Reading", filters: { tag: ["reading"] } });
		const picked = await createShelf(db, { name: "Picked" });
		await changeShelfItems(db, picked.id, [id("two"), id("three")], "add");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createAnansiServer(db);
		const client = new Client({ name: "mcp-shelves", version: "1" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const call = async (name: string, args: Record<string, unknown>) =>
			JSON.parse(String(((await client.callTool({ name, arguments: args })).content as Array<{ text?: string }>)[0]?.text));
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "list_shelves")).toBe(true);
			expect(Object.keys((tools.find((tool) => tool.name === "list_saved")!.inputSchema as { properties: object }).properties)).toContain("shelf");
			expect(await call("list_shelves", {})).toEqual({ shelves: [
				{ id: ruled.id, name: "Reading", count: 1 },
				{ id: picked.id, name: "Picked", count: 2 },
			] });
			const listed = await call("list_saved", { shelf: picked.id });
			expect(listed.results.map((row: { id: string }) => row.id).sort()).toEqual([id("two"), id("three")].sort());
			const searched = await call("search_saved", { query: "shelfword", shelf: ruled.id });
			expect(searched.results.map((row: { id: string }) => row.id)).toEqual([id("one")]);
			expect(await call("list_saved", { shelf: "missing" })).toEqual({ error: "no shelf with id missing" });
		} finally {
			await client.close();
			await server.close();
		}
	});
});
