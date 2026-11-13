import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLocalDb } from "./local.ts";
import { exportLibrary, restoreLibrary, saveCollection, listCollections } from "./organization.ts";
import { upsertItems, tagItems, setArchived, type IngestItem } from "./queries.ts";
import { restoreCounts, startLibraryRestore, writeLibraryRestoreChunk, finishLibraryRestore, RESTORE_TABLES, RESTORE_CHUNK_SIZE } from "./restore.ts";
import { validateRestoreBackup } from "./restore-preflight.ts";
import { collections, items, shelfItems } from "./schema.ts";
import { listItems } from "./search.ts";
import {
	SUGGESTION_MIN_SAVES, changeShelfItems, createShelf, deleteShelf, dismissShelfSuggestion, listShelves, reorderShelves,
	shelfRule, shelfScope, shelfSuggestions, shelvesForItem, updateShelf,
} from "./shelves.ts";
import { openTestDb } from "./test-db.ts";
import { createTopic, listTopics, updateTopic } from "./topic-settings.ts";
import { tags } from "./schema.ts";
import type { AnansiDb } from "./types.ts";

const sample = (externalId: string, patch: Partial<IngestItem> = {}): IngestItem => ({
	source: "web", externalId, url: `https://example.com/${externalId}`, kind: "article", title: externalId,
	body: `body of ${externalId}`, savedAt: 100, savedAtIsExact: true, media: [], metrics: {}, raw: {}, links: [], ...patch,
});

async function seed(db: AnansiDb, externalIds: string[]): Promise<Record<string, string>> {
	await upsertItems(db, externalIds.map((id) => sample(id)));
	const rows = await db.select({ id: items.id, externalId: items.externalId }).from(items);
	return Object.fromEntries(rows.map((row) => [row.externalId, row.id]));
}

const shelfIds = async (db: AnansiDb, shelfId: string) => {
	const scope = await shelfScope(db, shelfId);
	return (await listItems(db, { shelf: scope!, limit: 200 })).items.map((item) => item.id).sort();
};

describe("shelf membership", () => {
	test("a rule, hand-picked saves and hand-removed saves combine", async () => {
		const db = openTestDb();
		const id = await seed(db, ["a", "b", "c", "d"]);
		await tagItems(db, [id.a!, id.b!], "reading");
		const shelf = await createShelf(db, { name: "Reading", color: "teal", icon: "book-open", filters: { tag: ["reading"] } });
		expect(shelf).toMatchObject({ name: "Reading", color: "teal", icon: "book-open", position: 0, count: 2 });
		expect(await shelfIds(db, shelf.id)).toEqual([id.a!, id.b!].sort());

		await changeShelfItems(db, shelf.id, [id.c!], "add");
		expect(await shelfIds(db, shelf.id)).toEqual([id.a!, id.b!, id.c!].sort());

		// Removing a save the rule still matches records an exclusion.
		const removed = await changeShelfItems(db, shelf.id, [id.a!], "remove");
		expect(removed.shelf.count).toBe(2);
		expect(await db.select().from(shelfItems).where(eq(shelfItems.itemId, id.a!))).toMatchObject([{ mode: "exclude" }]);
		expect(await shelfIds(db, shelf.id)).toEqual([id.b!, id.c!].sort());
		expect(await shelvesForItem(db, id.a!)).toEqual([]);
		expect(await shelvesForItem(db, id.b!)).toEqual([shelf.id]);

		// Adding it back clears the exclusion.
		await changeShelfItems(db, shelf.id, [id.a!], "add");
		expect(await db.select().from(shelfItems).where(eq(shelfItems.itemId, id.a!))).toMatchObject([{ mode: "include" }]);

		// Removing a hand-picked save the rule does not match just unpins it.
		await changeShelfItems(db, shelf.id, [id.c!], "remove");
		expect(await db.select().from(shelfItems).where(eq(shelfItems.itemId, id.c!))).toEqual([]);
		expect((await listShelves(db))[0]?.count).toBe(2);
		expect(await shelfIds(db, shelf.id)).not.toContain(id.d!);
	});

	test("a shelf without a rule holds only hand-picked saves", async () => {
		const db = openTestDb();
		const id = await seed(db, ["a", "b"]);
		// Filters that narrow nothing leave the shelf hand-filled.
		expect(shelfRule({ removed: "exclude", order: "saved", archived: false, favorite: false })).toBeNull();
		const shelf = await createShelf(db, { name: "Picks", filters: { removed: "include" } });
		expect(shelf.count).toBe(0);
		await changeShelfItems(db, shelf.id, [id.b!], "add");
		expect(await shelfIds(db, shelf.id)).toEqual([id.b!]);
		await changeShelfItems(db, shelf.id, [id.b!], "remove");
		expect(await db.select().from(shelfItems)).toEqual([]);
	});

	test("rules read the library's own filters, including the URL's `type` and a keyword query", async () => {
		const db = openTestDb();
		await upsertItems(db, [sample("repo", { source: "github", kind: "repo", body: "zebrafish tooling" }), sample("page", { body: "zebrafish notes" })]);
		const repos = await createShelf(db, { name: "Repos", filters: { type: ["repo"] } });
		const fish = await createShelf(db, { name: "Fish", filters: { query: "zebrafish", source: ["web"] } });
		expect(repos.count).toBe(1);
		expect(fish.count).toBe(1);
	});

	test("putting hundreds of saves on a shelf is split into bounded statements", async () => {
		const db = openTestDb();
		const id = await seed(db, Array.from({ length: 250 }, (_, n) => `bulk-${n}`));
		const all = Object.values(id);
		await tagItems(db, all, "bulk");
		const picked = await createShelf(db, { name: "All picked" });
		const added = await changeShelfItems(db, picked.id, all, "add");
		expect(added.changed).toBe(250);
		expect(added.shelf.count).toBe(250);
		const ruled = await createShelf(db, { name: "Bulk", filters: { tag: ["bulk"] } });
		const removed = await changeShelfItems(db, ruled.id, all.slice(0, 180), "remove");
		expect(removed.changed).toBe(180);
		expect(removed.shelf.count).toBe(70);
		await expect(changeShelfItems(db, ruled.id, Array.from({ length: 501 }, (_, n) => `x${n}`), "add")).rejects.toThrow("itemIds");
	});

	test("archived saves leave the default count; deleting a shelf keeps its saves", async () => {
		const db = openTestDb();
		const id = await seed(db, ["a", "b"]);
		const shelf = await createShelf(db, { name: "Picks" });
		await changeShelfItems(db, shelf.id, [id.a!, id.b!], "add");
		await setArchived(db, [id.a!], true);
		expect((await listShelves(db))[0]?.count).toBe(1);
		expect(await deleteShelf(db, shelf.id)).toBe(true);
		expect(await db.select().from(shelfItems)).toEqual([]);
		expect((await db.select().from(items)).length).toBe(2);
	});
});

describe("shelf management", () => {
	test("create, update, validate and reorder", async () => {
		const db = openTestDb();
		const a = await createShelf(db, { name: "A" });
		const b = await createShelf(db, { name: "B" });
		const c = await createShelf(db, { name: "C" });
		expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
		await expect(createShelf(db, { name: " " })).rejects.toThrow("name");
		await expect(createShelf(db, { name: "x", color: "#ff0000" })).rejects.toThrow("color");
		await expect(createShelf(db, { name: "x", icon: "<svg>" })).rejects.toThrow("icon");
		await expect(createShelf(db, { name: "x", filters: { author: Array.from({ length: 120 }, (_, n) => `a${n}`) } })).rejects.toThrow("too many");

		const renamed = await updateShelf(db, b.id, { name: "Bee", color: "amber", icon: null });
		expect(renamed).toMatchObject({ name: "Bee", color: "amber", icon: null });
		await expect(updateShelf(db, "missing", { name: "x" })).rejects.toThrow("No such shelf");

		const reordered = await reorderShelves(db, [c.id, a.id]);
		expect(reordered.map((shelf) => [shelf.id, shelf.position])).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]]);
		// The saved-views API sees the same order.
		expect((await listCollections(db)).map((row) => row.id)).toEqual([c.id, a.id, b.id]);
		const legacy = await saveCollection(db, { name: "Old client", filters: {} });
		expect((await listShelves(db)).at(-1)).toMatchObject({ id: legacy.id, position: 3 });
	});

	test("migration 0033 numbers existing saved views by age", () => {
		const db = openLocalDb(":memory:");
		const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
		const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
		for (const name of files.filter((name) => Number(name.slice(0, 4)) < 33)) db.$client.exec(readFileSync(`${directory}/${name}`, "utf8").replaceAll("--> statement-breakpoint", ""));
		const insert = db.$client.prepare("insert into collections (id, name, filters, created_at, updated_at) values (?, ?, '{}', ?, ?)");
		insert.run("late", "Late", 300, 300);
		insert.run("early", "Early", 100, 100);
		insert.run("middle", "Middle", 200, 200);
		db.$client.exec(readFileSync(`${directory}/${files.find((name) => name.startsWith("0033"))}`, "utf8").replaceAll("--> statement-breakpoint", ""));
		expect(db.$client.prepare("select id, position from collections order by position").all()).toEqual([
			{ id: "early", position: 0 }, { id: "middle", position: 1 }, { id: "late", position: 2 },
		]);
	});
});

describe("topic shelf suggestions", () => {
	test("topics with enough saves, not already a shelf and not dismissed", async () => {
		const db = openTestDb();
		const id = await seed(db, Array.from({ length: SUGGESTION_MIN_SAVES + 2 }, (_, n) => `s${n}`));
		const all = Object.values(id);
		await tagItems(db, all, "Design");
		await tagItems(db, all.slice(0, SUGGESTION_MIN_SAVES - 1), "Gaming");
		await tagItems(db, all, "Music");
		expect((await shelfSuggestions(db)).map((entry) => entry.topic)).toEqual(["design", "music"]);
		expect((await shelfSuggestions(db))[0]).toEqual({ topic: "design", label: "Design", count: SUGGESTION_MIN_SAVES + 2, filters: { tag: ["Design"] } });

		await createShelf(db, { name: "Design", filters: { tag: ["Design"], removed: "include" } });
		await dismissShelfSuggestion(db, "music");
		expect(await shelfSuggestions(db)).toEqual([]);
	});

	test("a topic in a richer rule is still suggested", async () => {
		const db = openTestDb();
		const all = Object.values(await seed(db, Array.from({ length: SUGGESTION_MIN_SAVES }, (_, n) => `s${n}`)));
		await tagItems(db, all, "Design");
		await createShelf(db, { name: "Web design", filters: { tag: ["Design"], source: ["web"] } });
		expect((await shelfSuggestions(db)).map((entry) => entry.topic)).toEqual(["design"]);
	});
});

describe("shelf backup", () => {
	async function library() {
		const db = openTestDb();
		const id = await seed(db, ["a", "b", "c"]);
		await tagItems(db, [id.a!, id.b!], "reading");
		const ruled = await createShelf(db, { name: "Reading", color: "violet", icon: "book", filters: { tag: ["reading"] } });
		const picked = await createShelf(db, { name: "Picks", color: "red" });
		await changeShelfItems(db, ruled.id, [id.a!], "remove");
		await changeShelfItems(db, picked.id, [id.c!], "add");
		await reorderShelves(db, [picked.id, ruled.id]);
		await updateTopic(db, "gaming", { enabled: false });
		await updateTopic(db, "music", { description: "Vinyl only." });
		await createTopic(db, { label: "Rust", description: "Crates and cargo." });
		return db;
	}
	const snapshot = async (db: AnansiDb) => ({
		shelves: (await listShelves(db)).map(({ id, name, color, icon, position, filters, count }) => ({ id, name, color, icon, position, filters, count })),
		shelfItems: (await db.select().from(shelfItems)).sort((x, y) => x.itemId.localeCompare(y.itemId)),
		topics: await listTopics(db),
		rustTag: await db.select().from(tags).where(eq(tags.id, "topic:custom-rust")),
	});

	test("export then a small restore round-trips shelves", async () => {
		const source = await library();
		const backup = JSON.parse(JSON.stringify(await exportLibrary(source)));
		expect(backup.shelfItems).toHaveLength(2);
		const target = openTestDb();
		await restoreLibrary(target, backup);
		expect(await snapshot(target)).toEqual(await snapshot(source));
	});

	test("the resumable restore carries shelves and older exports without shelfItems still restore", async () => {
		const source = await library();
		const { backup, counts } = validateRestoreBackup(JSON.parse(JSON.stringify(await exportLibrary(source))));
		expect(counts.shelfItems).toBe(2);
		expect(restoreCounts(backup)).toEqual(counts);
		const target = openTestDb();
		const backupId = "a".repeat(64);
		await startLibraryRestore(target, backupId, counts);
		for (const table of RESTORE_TABLES) {
			const rows = (backup[table] ?? []) as unknown[];
			for (let offset = 0; offset < rows.length; offset += RESTORE_CHUNK_SIZE) {
				await writeLibraryRestoreChunk(target, { backupId, table, offset, rows: rows.slice(offset, offset + RESTORE_CHUNK_SIZE) });
			}
		}
		await finishLibraryRestore(target, backupId);
		expect(await snapshot(target)).toEqual(await snapshot(source));

		const legacy = JSON.parse(JSON.stringify(await exportLibrary(source)));
		delete legacy.shelfItems;
		delete legacy.aiTopics;
		for (const row of legacy.collections) { delete row.color; delete row.icon; delete row.position; }
		expect(validateRestoreBackup(legacy).counts.shelfItems).toBe(0);
		const older = openTestDb();
		await restoreLibrary(older, legacy);
		expect((await older.select().from(collections)).map((row) => row.position)).toEqual([0, 0]);
		expect((await listTopics(older)).every((topic) => topic.builtIn && topic.enabled)).toBe(true);
	});

	test("a restore replaces this installation's topic list with the backup's", async () => {
		const backup = JSON.parse(JSON.stringify(await exportLibrary(await library())));
		expect(backup.aiTopics.map((row: { id: string }) => row.id).sort()).toEqual(["custom-rust", "gaming", "music"]);
		const target = openTestDb();
		await updateTopic(target, "gaming", { enabled: true, description: "Local edit." });
		await restoreLibrary(target, backup);
		expect((await listTopics(target)).find((topic) => topic.id === "gaming")).toMatchObject({ enabled: false });
		const broken = JSON.parse(JSON.stringify(backup));
		broken.aiTopics.push({ id: "sneaky", builtIn: 0, label: "Sneaky", createdAt: 1, updatedAt: 1 });
		expect(() => validateRestoreBackup(broken)).toThrow("aiTopics");
	});

	test("preflight rejects shelf rows that point nowhere", async () => {
		const backup = JSON.parse(JSON.stringify(await exportLibrary(await library())));
		backup.shelfItems[0].shelfId = "missing";
		expect(() => validateRestoreBackup(backup)).toThrow("shelfItems");
	});
});
