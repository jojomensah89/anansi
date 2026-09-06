import { describe, expect, test } from "bun:test";
import { upsertItems } from "./queries.ts";
import { listItems } from "./search.ts";
import { openTestDb } from "./test-db.ts";

/**
 * "is any of", from the chip down to the SQL.
 *
 * The bar used to offer one value per field, so these questions could not be
 * asked at all: everything from two platforms, anything by either of two
 * people, repos and comments but nothing else.
 */
const item = (
	patch: Partial<{
		source: string;
		externalId: string;
		author: string;
		kind: string;
		raw: Record<string, unknown>;
		media: { kind: string; originUrl: string }[];
	}> = {},
) => ({
	source: patch.source ?? "x",
	externalId: patch.externalId ?? Math.random().toString(36).slice(2),
	url: "https://example.com/a",
	kind: patch.kind ?? "post",
	body: "body text",
	authorHandle: patch.author ?? "ada",
	postedAt: 1_000,
	savedAt: 1_000,
	savedAtIsExact: false,
	metrics: {},
	media: patch.media ?? [],
	links: [],
	raw: patch.raw ?? {},
});

const ids = async (db: Awaited<ReturnType<typeof openTestDb>>, opts: object) =>
	(await listItems(db, { limit: 50, ...opts })).items.map((i) => i.source);

describe("source is any of", () => {
	test("several sources return all of them, not none of them", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ source: "x", externalId: "a" }),
			item({ source: "reddit", externalId: "b" }),
			item({ source: "reddit", externalId: "c" }),
			item({ source: "github", externalId: "d", kind: "repo" }),
		]);

		const both = await ids(db, { source: ["x", "github"] });
		expect(both.sort()).toEqual(["github", "x"]);
	});

	test("a single value still works, so every existing caller does", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ source: "x", externalId: "a" }),
			item({ source: "reddit", externalId: "b" }),
		]);

		expect(await ids(db, { source: "reddit" })).toEqual(["reddit"]);
	});

	test("an empty selection is an absent filter, not an empty library", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ source: "x", externalId: "a" }),
			item({ source: "reddit", externalId: "b" }),
		]);

		expect((await ids(db, { source: [] })).length).toBe(2);
		expect((await ids(db, { source: undefined })).length).toBe(2);
	});

	test("a value nobody has selects nothing rather than everything", async () => {
		const db = openTestDb();
		await upsertItems(db, [item({ source: "x", externalId: "a" })]);

		expect(await ids(db, { source: ["bluesky"] })).toEqual([]);
	});
});

describe("author is any of", () => {
	test("either of two people", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ externalId: "a", author: "ada" }),
			item({ externalId: "b", author: "kwame" }),
			item({ externalId: "c", author: "maya" }),
		]);

		const page = await listItems(db, { author: ["ada", "kwame"], limit: 50 });
		expect(page.items.map((i) => i.author).sort()).toEqual(["ada", "kwame"]);
	});
});

describe("content type is any of", () => {
	test("several types are ORed, because ANDing them is a contradiction", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ externalId: "repo", source: "github", kind: "repo" }),
			item({ externalId: "comment", source: "reddit", raw: { isComment: 1 } }),
			item({ externalId: "plain", source: "x" }),
		]);

		// Nothing is both a repo and a comment; ANDing would empty the grid.
		const page = await listItems(db, {
			contentType: ["repo", "comment"],
			limit: 50,
		});
		expect(page.items.length).toBe(2);
	});

	test("one type on its own is unchanged", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ externalId: "repo", source: "github", kind: "repo" }),
			item({ externalId: "plain", source: "x" }),
		]);

		const page = await listItems(db, { contentType: "repo", limit: 50 });
		expect(page.items.map((i) => i.source)).toEqual(["github"]);
	});

	test("an unknown type is ignored rather than emptying the grid", async () => {
		const db = openTestDb();
		await upsertItems(db, [item({ externalId: "a" })]);

		expect((await listItems(db, { contentType: ["nonsense"], limit: 50 })).items.length).toBe(1);
	});
});

describe("filters combine", () => {
	test("different fields AND, values within a field OR", async () => {
		const db = openTestDb();
		await upsertItems(db, [
			item({ externalId: "a", source: "x", author: "ada" }),
			item({ externalId: "b", source: "reddit", author: "ada" }),
			item({ externalId: "c", source: "x", author: "kwame" }),
			item({ externalId: "d", source: "reddit", author: "maya" }),
		]);

		const page = await listItems(db, {
			source: ["x", "reddit"],
			author: ["ada"],
			limit: 50,
		});
		expect(page.items.length).toBe(2);
		expect(page.items.every((i) => i.author === "ada")).toBe(true);
	});

	test("duplicate values do not multiply rows", async () => {
		const db = openTestDb();
		await upsertItems(db, [item({ externalId: "a", source: "x" })]);

		const page = await listItems(db, { source: ["x", "x", "x"], limit: 50 });
		expect(page.items.length).toBe(1);
	});
});

describe("a value cannot become SQL", () => {
	test("a quote-and-paren payload is bound, not interpolated", async () => {
		const db = openTestDb();
		await upsertItems(db, [item({ externalId: "a", source: "x" })]);

		const hostile = "x') or 1=1 --";
		const page = await listItems(db, { source: ["x", hostile], limit: 50 });
		// The real row still matches; the payload matched nothing and threw
		// nothing.
		expect(page.items.length).toBe(1);
	});
});
