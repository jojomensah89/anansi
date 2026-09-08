import { describe, expect, test } from "bun:test";
import type { AnansiDb } from "@anansi/db";
import { openD1 } from "@anansi/db/d1";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnansiServer } from "./index.ts";

/**
 * A read-only D1-shaped binding. The D1 adapter must be able to prepare and
 * execute every MCP query without importing Bun SQLite or relying on local
 * result objects. This intentionally returns an empty result set: query
 * semantics are covered by the SQLite fixture, while this test protects the
 * deployment driver's call shape and the shared MCP registration surface.
 */
class EmptyD1Statement {
	constructor(
		readonly sql: string,
		readonly params: unknown[] = [],
	) {}

	bind(...params: unknown[]) {
		return new EmptyD1Statement(this.sql, params);
	}

	async all() {
		return { success: true, results: [], meta: {} };
	}

	async raw() {
		return [];
	}
}

class EmptyD1 {
	readonly selects: string[] = [];

	prepare(sql: string) {
		this.selects.push(sql);
		return new EmptyD1Statement(sql);
	}
}

describe("MCP D1 adapter compatibility", () => {
	test("registers and executes every read-only tool through a D1 binding", async () => {
		const binding = new EmptyD1();
		const db = openD1(binding as unknown as D1Database);
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const server = createAnansiServer(db as AnansiDb);
		const client = new Client({ name: "mcp-d1-test", version: "1" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		try {
			const names = (await client.listTools()).tools.map((tool) => tool.name);
			for (const name of names) {
				const argumentsByTool: Record<string, Record<string, unknown>> = {
					search_saved: { query: "empty" },
					get_saved: { id: "missing" },
					get_saved_many: { ids: ["missing"] },
					list_saved: {},
					list_recent_saves: {},
					list_author_saves: { handle: "missing" },
					list_tags: {},
					library_stats: {},
				};
				const response = await client.callTool({
					name,
					arguments: argumentsByTool[name],
				});
				expect(response.isError).not.toBe(true);
			}
			expect(binding.selects.length).toBeGreaterThan(0);
		} finally {
			await client.close();
			await server.close();
		}
	});
});
