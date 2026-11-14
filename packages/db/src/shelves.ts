import { parseShelfRule as shelfRule } from "./shelf-rule.ts";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { mutationChanges } from "./ai-jobs.ts";
import { collections, shelfSuggestionDismissals } from "./schema.ts";
import { libraryFilterClause, shelfMembership, type ShelfScope } from "./search.ts";
import { activeTopics } from "./topic-settings.ts";
import type { AnansiDb } from "./types.ts";
import { visibleSourceClause } from "./visibility.ts";

/**
 * Shelves: a name, a colour, an icon, and what is on them.
 *
 * A save is on a shelf when it was put there by hand, or when the shelf has a
 * rule, the save matches it, and it was not taken off by hand. Rules are the
 * library's own filters and are matched by the library's own query builder,
 * so a shelf never disagrees with the grid showing the same filters.
 */

export const SHELF_COLORS = ["slate", "red", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink"] as const;
export type ShelfColor = (typeof SHELF_COLORS)[number];
export const SHELF_NAME_MAX = 100;
/** Items one add/remove call accepts. */
export const SHELF_ITEMS_MAX = 500;
/** D1 refuses a statement with more than 100 bound parameters. */
const D1_PARAMS = 100;
/** A rule leaves room for the few parameters each shelf statement adds around it. */
const RULE_PARAMS_MAX = 80;
/** Saves written per statement when putting items on or taking them off a shelf. */
export const SHELF_WRITE_CHUNK = 100;
export const SUGGESTION_MIN_SAVES = 20;

/** Stored filters as the client sent them, minus paging. */
export type ShelfFilters = Record<string, unknown>;

export interface Shelf {
	id: string;
	name: string;
	color: ShelfColor | null;
	icon: string | null;
	position: number;
	filters: ShelfFilters;
	createdAt: number;
	updatedAt: number;
}

export interface ShelfWithCount extends Shelf {
	count: number;
}

export class ShelfError extends Error {
	readonly status: 400 | 404;
	constructor(status: 400 | 404, message: string) {
		super(message);
		this.name = "ShelfError";
		this.status = status;
	}
}

const dialect = new SQLiteSyncDialect();
const paramCount = (query: SQL) => dialect.sqlToQuery(query).params.length;
const now = () => Math.floor(Date.now() / 1000);

export { parseShelfRule as shelfRule } from "./shelf-rule.ts";
/** What gets stored: the client's filters without paging or a nested shelf. */
function storedFilters(filters: unknown): ShelfFilters {
	if (filters === undefined || filters === null) return {};
	if (typeof filters !== "object" || Array.isArray(filters)) throw new ShelfError(400, "filters must be an object");
	const { cursor: _cursor, limit: _limit, shelf: _shelf, ...rest } = filters as Record<string, unknown>;
	const rule = shelfRule(rest);
	if (rule && paramCount(libraryFilterClause(rule)) > RULE_PARAMS_MAX) throw new ShelfError(400, "This rule has too many values for one shelf");
	if (JSON.stringify(rest).length > 8_000) throw new ShelfError(400, "filters are too large");
	return rest;
}

function validName(value: unknown): string {
	if (typeof value !== "string") throw new ShelfError(400, "Shelf name is required");
	const name = value.replace(/\s+/g, " ").trim();
	if (!name || name.length > SHELF_NAME_MAX) throw new ShelfError(400, `Shelf name must be 1–${SHELF_NAME_MAX} characters`);
	return name;
}

function validColor(value: unknown): ShelfColor | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !SHELF_COLORS.includes(value as ShelfColor)) throw new ShelfError(400, `color must be one of ${SHELF_COLORS.join(", ")}`);
	return value as ShelfColor;
}

function validIcon(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new ShelfError(400, "icon must be a lucide icon name");
	return value;
}

function parseFilters(text: string): ShelfFilters {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as ShelfFilters : {};
	} catch {
		return {};
	}
}

function toShelf(row: typeof collections.$inferSelect): Shelf {
	return {
		id: row.id,
		name: row.name,
		color: SHELF_COLORS.includes(row.color as ShelfColor) ? row.color as ShelfColor : null,
		icon: row.icon ?? null,
		position: row.position,
		filters: parseFilters(row.filters),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export const scopeOf = (shelf: Pick<Shelf, "id" | "filters">): ShelfScope => ({ id: shelf.id, rule: shelfRule(shelf.filters) });

/**
 * Run one small SELECT per shelf, packed into UNION ALL statements that each
 * stay under D1's parameter ceiling. Rules are capped well below it, so every
 * shelf fits; most libraries need a single statement.
 */
async function perShelf<Row>(db: AnansiDb, parts: SQL[]): Promise<Row[]> {
	const groups: SQL[][] = [];
	let current: SQL[] = [];
	let used = 0;
	for (const part of parts) {
		const cost = paramCount(part);
		if (current.length > 0 && used + cost > D1_PARAMS) {
			groups.push(current);
			current = [];
			used = 0;
		}
		current.push(part);
		used += cost;
	}
	if (current.length > 0) groups.push(current);
	const rows: Row[] = [];
	for (const group of groups) rows.push(...await db.all<Row>(sql.join(group, sql` union all `)));
	return rows;
}

/** What the shelf shows by default: visible, unarchived, safe-for-work saves. */
function countPart(shelf: ShelfScope): SQL {
	return sql`select ${shelf.id} as id, count(*) as n from items i
		where ${visibleSourceClause(sql`i.source`)} ${shelf.rule?.archived ? sql`and i.archived_at is not null` : sql`and i.archived_at is null`} ${shelf.rule?.nsfw ? sql`` : sql`and coalesce(i.nsfw, 0) = 0`}
		and ${shelfMembership(shelf)}`;
}

async function counts(db: AnansiDb, shelves: readonly Shelf[]): Promise<Map<string, number>> {
	const rows = await perShelf<{ id: string; n: number }>(db, shelves.map((shelf) => countPart(scopeOf(shelf))));
	return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

export async function listShelves(db: AnansiDb): Promise<ShelfWithCount[]> {
	const shelves = (await db.select().from(collections).orderBy(asc(collections.position), asc(collections.createdAt), asc(collections.id))).map(toShelf);
	const byId = await counts(db, shelves);
	return shelves.map((shelf) => ({ ...shelf, count: byId.get(shelf.id) ?? 0 }));
}

export async function getShelf(db: AnansiDb, id: string): Promise<Shelf | null> {
	const [row] = await db.select().from(collections).where(eq(collections.id, id));
	return row ? toShelf(row) : null;
}

/** The query layer's view of a shelf, for `listItems({ shelf })`. */
export async function shelfScope(db: AnansiDb, id: string): Promise<ShelfScope | null> {
	const shelf = await getShelf(db, id);
	return shelf ? scopeOf(shelf) : null;
}

async function withCount(db: AnansiDb, shelf: Shelf): Promise<ShelfWithCount> {
	return { ...shelf, count: (await counts(db, [shelf])).get(shelf.id) ?? 0 };
}

export async function createShelf(db: AnansiDb, input: { name: unknown; color?: unknown; icon?: unknown; filters?: unknown }): Promise<ShelfWithCount> {
	const name = validName(input.name);
	const color = validColor(input.color);
	const icon = validIcon(input.icon);
	const filters = storedFilters(input.filters);
	const id = crypto.randomUUID();
	const at = now();
	await db.run(sql`
		insert into collections (id, name, filters, created_at, updated_at, color, icon, position)
		select ${id}, ${name}, ${JSON.stringify(filters)}, ${at}, ${at}, ${color}, ${icon}, coalesce(max(position), -1) + 1 from collections`);
	const shelf = await getShelf(db, id);
	if (!shelf) throw new Error("Shelf could not be saved");
	return withCount(db, shelf);
}

export async function updateShelf(db: AnansiDb, id: string, changes: { name?: unknown; color?: unknown; icon?: unknown; filters?: unknown }): Promise<ShelfWithCount> {
	const set: Partial<typeof collections.$inferInsert> = { updatedAt: now() };
	if (changes.name !== undefined) set.name = validName(changes.name);
	if (changes.color !== undefined) set.color = validColor(changes.color);
	if (changes.icon !== undefined) set.icon = validIcon(changes.icon);
	if (changes.filters !== undefined) set.filters = JSON.stringify(storedFilters(changes.filters));
	const result = await db.update(collections).set(set).where(eq(collections.id, id)).run();
	if (mutationChanges(result) === 0) throw new ShelfError(404, "No such shelf");
	const shelf = await getShelf(db, id);
	if (!shelf) throw new ShelfError(404, "No such shelf");
	return withCount(db, shelf);
}

/** Saves stay in the library; only the shelf and its hand-picked list go. */
export async function deleteShelf(db: AnansiDb, id: string): Promise<boolean> {
	return mutationChanges(await db.delete(collections).where(eq(collections.id, id)).run()) > 0;
}

/** Listed shelves take the first places in that order; any not listed follow in their old order. */
export async function reorderShelves(db: AnansiDb, ids: readonly string[]): Promise<ShelfWithCount[]> {
	const current = await db.select({ id: collections.id }).from(collections).orderBy(asc(collections.position), asc(collections.createdAt), asc(collections.id));
	const known = new Set(current.map((row) => row.id));
	const listed = [...new Set(ids)].filter((id) => known.has(id));
	const listedSet = new Set(listed);
	const order = [...listed, ...current.map((row) => row.id).filter((id) => !listedSet.has(id))];
	if (order.length > 0) {
		const json = JSON.stringify(order);
		await db.run(sql`
			update collections set position = (select cast(key as integer) from json_each(${json}) where value = collections.id)
			where id in (select value from json_each(${json}))`);
	}
	return listShelves(db);
}

function validItemIds(itemIds: unknown): string[] {
	if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > SHELF_ITEMS_MAX
		|| itemIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
		throw new ShelfError(400, `itemIds must list 1–${SHELF_ITEMS_MAX} item ids`);
	}
	return [...new Set(itemIds as string[])];
}

/**
 * Put saves on a shelf, or take them off.
 *
 * Adding pins each save to the shelf and clears any earlier removal.
 * Removing unpins it and, when the shelf's rule would still bring it back,
 * records the removal so it stays off.
 */
export async function changeShelfItems(db: AnansiDb, shelfId: string, itemIds: unknown, action: unknown): Promise<{ changed: number; shelf: ShelfWithCount }> {
	if (action !== "add" && action !== "remove") throw new ShelfError(400, "action must be add or remove");
	const ids = validItemIds(itemIds);
	const shelf = await getShelf(db, shelfId);
	if (!shelf) throw new ShelfError(404, "No such shelf");
	const rule = shelfRule(shelf.filters);
	const at = now();
	let changed = 0;
	for (let offset = 0; offset < ids.length; offset += SHELF_WRITE_CHUNK) {
		const chunk = JSON.stringify(ids.slice(offset, offset + SHELF_WRITE_CHUNK));
		if (action === "add") {
			changed += mutationChanges(await db.run(sql`
				insert into shelf_items (shelf_id, item_id, mode, created_at)
				select ${shelfId}, value, 'include', ${at} from json_each(${chunk})
				where exists (select 1 from items where items.id = value)
				on conflict (shelf_id, item_id) do update set mode = 'include', created_at = excluded.created_at
				where shelf_items.mode != 'include'`));
			continue;
		}
		changed += mutationChanges(await db.run(sql`
			delete from shelf_items where shelf_id = ${shelfId} and mode = 'include'
			and item_id in (select value from json_each(${chunk}))`));
		if (!rule) continue;
		changed += mutationChanges(await db.run(sql`
			insert into shelf_items (shelf_id, item_id, mode, created_at)
			select ${shelfId}, i.id, 'exclude', ${at} from items i
			where i.id in (select value from json_each(${chunk})) ${libraryFilterClause(rule)}
			on conflict (shelf_id, item_id) do nothing`));
	}
	return { changed, shelf: await withCount(db, shelf) };
}

/** The shelves one save is on, in shelf order. */
export async function shelvesForItem(db: AnansiDb, itemId: string): Promise<string[]> {
	const shelves = (await db.select().from(collections).orderBy(asc(collections.position), asc(collections.createdAt), asc(collections.id))).map(toShelf);
	if (shelves.length === 0) return [];
	const rows = await perShelf<{ id: string }>(db, shelves.map((shelf) => sql`select ${shelf.id} as id from items i where i.id = ${itemId} and ${shelfMembership(scopeOf(shelf))}`));
	const on = new Set(rows.map((row) => row.id));
	return shelves.filter((shelf) => on.has(shelf.id)).map((shelf) => shelf.id);
}

export interface ShelfSuggestion {
	/** The topic id; pass it back to dismiss. */
	topic: string;
	label: string;
	count: number;
	/** Ready to send as a new shelf's filters. */
	filters: { tag: string[] };
}

/**
 * Topics big enough to deserve a shelf: on at least twenty visible saves, not
 * already the whole rule of a shelf, and not turned down before.
 */
export async function shelfSuggestions(db: AnansiDb): Promise<ShelfSuggestion[]> {
	const [topics, tagCounts, shelves, dismissed] = await Promise.all([
		activeTopics(db),
		db.all<{ tagId: string; n: number }>(sql`
			select it.tag_id as tagId, count(*) as n
			from item_tags it join items i on i.id = it.item_id
			where substr(it.tag_id, 1, 6) = 'topic:' and i.archived_at is null and ${visibleSourceClause(sql`i.source`)}
			group by it.tag_id having count(*) >= ${SUGGESTION_MIN_SAVES}`),
		db.select({ filters: collections.filters }).from(collections),
		db.select({ topic: shelfSuggestionDismissals.topic }).from(shelfSuggestionDismissals),
	]);
	const byTag = new Map(tagCounts.map((row) => [row.tagId, Number(row.n)]));
	const taken = new Set<string>();
	for (const row of shelves) {
		const rule = shelfRule(parseFilters(row.filters));
		if (!rule || rule.tag?.length !== 1) continue;
		const { tag, removed, nsfw: _nsfw, ...rest } = rule;
		if (Object.keys(rest).length === 0 && removed !== "only") taken.add(tag[0]!.toLowerCase());
	}
	const no = new Set(dismissed.map((row) => row.topic));
	return topics
		.flatMap((topic) => {
			const count = byTag.get(topic.tagId) ?? 0;
			if (count < SUGGESTION_MIN_SAVES || no.has(topic.id) || taken.has(topic.label.toLowerCase())) return [];
			return [{ topic: topic.id, label: topic.label, count, filters: { tag: [topic.label] } }];
		})
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function dismissShelfSuggestion(db: AnansiDb, topic: unknown): Promise<void> {
	if (typeof topic !== "string" || !topic || topic.length > 80) throw new ShelfError(400, "topic is required");
	await db.insert(shelfSuggestionDismissals).values({ topic, dismissedAt: now() })
		.onConflictDoUpdate({ target: shelfSuggestionDismissals.topic, set: { dismissedAt: now() } });
}
