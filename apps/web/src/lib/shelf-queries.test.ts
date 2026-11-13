import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ItemRow, Page, Shelf } from "./api.ts";
import { libraryKeys } from "./library-query.ts";
import { applyMembership, applyReorder, restoreMembership, sendMembership } from "./shelf-queries.ts";
import { shelfKeys } from "./shelves.ts";

const shelf = (id: string, position: number, count = 10): Shelf => ({
	id, name: id, color: null, icon: null, position, filters: {}, count, createdAt: 0, updatedAt: 0,
});
const row = (id: string) => ({ id } as ItemRow);
const original = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = original;
});

describe("reorder is drawn before the server answers", () => {
	test("the cached list takes the new order at once and hands back what to restore", () => {
		const client = new QueryClient();
		const before = { shelves: [shelf("a", 0), shelf("b", 1), shelf("c", 2)] };
		client.setQueryData(shelfKeys.list(), before);
		const { previous, ids } = applyReorder(client, "c", 0);
		expect(ids).toEqual(["c", "a", "b"]);
		expect(client.getQueryData<{ shelves: Shelf[] }>(shelfKeys.list())!.shelves.map((entry) => [entry.id, entry.position])).toEqual([["c", 0], ["a", 1], ["b", 2]]);
		// A failed request puts the old order back.
		client.setQueryData(shelfKeys.list(), previous);
		expect(client.getQueryData<{ shelves: Shelf[] }>(shelfKeys.list())!.shelves.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
	});
});

describe("membership is drawn before the server answers", () => {
	function seed() {
		const client = new QueryClient();
		client.setQueryData(shelfKeys.list(), { shelves: [shelf("s1", 0, 4), shelf("s2", 1, 9)] });
		client.setQueryData(libraryKeys.detail("i1"), { id: "i1", shelves: ["s2"] });
		const viewing = libraryKeys.page("", { shelf: "s2", order: "saved", limit: 60 });
		const library = libraryKeys.page("", { order: "saved", limit: 60 });
		const pages = { pages: [{ items: [row("i1"), row("i2")], nextCursor: null } as Page], pageParams: [null] };
		client.setQueryData(viewing, pages);
		client.setQueryData(library, pages);
		return { client, viewing, library };
	}
	const counts = (client: QueryClient) => client.getQueryData<{ shelves: Shelf[] }>(shelfKeys.list())!.shelves.map((entry) => entry.count);

	test("adding checks the shelf on the save and counts it", () => {
		const { client } = seed();
		applyMembership(client, { shelf: { id: "s1", name: "s1" }, itemIds: ["i1"], on: true });
		expect(client.getQueryData<{ shelves: string[] }>(libraryKeys.detail("i1"))!.shelves.sort()).toEqual(["s1", "s2"]);
		expect(counts(client)).toEqual([5, 9]);
	});

	test("adding a save that is already there changes no count", () => {
		const { client } = seed();
		applyMembership(client, { shelf: { id: "s2", name: "s2" }, itemIds: ["i1"], on: true });
		expect(counts(client)).toEqual([4, 9]);
	});

	test("removing takes the save off the viewed shelf only, and restore undoes all of it", () => {
		const { client, viewing, library } = seed();
		const snapshot = applyMembership(client, { shelf: { id: "s2", name: "s2" }, itemIds: ["i1"], on: false });
		const ids = (key: readonly unknown[]) => client.getQueryData<{ pages: Page[] }>(key)!.pages[0]!.items.map((item) => item.id);
		expect(ids(viewing)).toEqual(["i2"]);
		expect(ids(library)).toEqual(["i1", "i2"]);
		expect(client.getQueryData<{ shelves: string[] }>(libraryKeys.detail("i1"))!.shelves).toEqual([]);
		expect(counts(client)).toEqual([4, 8]);

		restoreMembership(client, snapshot);
		expect(ids(viewing)).toEqual(["i1", "i2"]);
		expect(client.getQueryData<{ shelves: string[] }>(libraryKeys.detail("i1"))!.shelves).toEqual(["s2"]);
		expect(counts(client)).toEqual([4, 9]);
	});
});

test("a large selection is sent in batches of 500, and the last reply's shelf wins", async () => {
	const bodies: { itemIds: string[]; action: string }[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		bodies.push(body);
		return Response.json({ changed: body.itemIds.length, shelf: shelf("s1", 0, bodies.length * 100) });
	}) as typeof fetch;
	const ids = Array.from({ length: 1100 }, (_, index) => `i${index}`);
	const result = await sendMembership({ shelf: { id: "s1", name: "s1" }, itemIds: ids, on: true });
	expect(bodies.map((body) => [body.itemIds.length, body.action])).toEqual([[500, "add"], [500, "add"], [100, "add"]]);
	expect(result.changed).toBe(1100);
	expect(result.shelf?.count).toBe(300);
});
