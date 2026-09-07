import { and, eq, inArray, sql } from "drizzle-orm";
import { collections, highlights, itemTagOverrides, items, itemTags, media, tags } from "./schema.ts";
import type { AnansiDb } from "./types.ts";
import { atomicWrite } from "./atomic.ts";
import type { ListOptions } from "./search.ts";
import { isHiddenSource } from "./visibility.ts";
import { canonicalTopicId, topicDefinition } from "./topics.ts";

export type CollectionFilters = Omit<ListOptions, "cursor" | "limit"> & { query?: string };
export interface Collection { id: string; name: string; filters: CollectionFilters; createdAt: number; updatedAt: number }

export async function setItemNote(db: AnansiDb, id: string, note: string): Promise<void> {
  if (note.length > 20_000) throw new Error("A note can contain at most 20,000 characters");
  await db.update(items).set({ note }).where(eq(items.id, id));
}

export async function setFavorite(db: AnansiDb, ids: string[], favorite: boolean): Promise<void> {
  for (let i = 0; i < ids.length; i += 90) {
    await db.update(items).set({ favorite: favorite ? 1 : 0 }).where(inArray(items.id, ids.slice(i, i + 90)));
  }
}

export async function removeItemTag(db: AnansiDb, id: string, label: string): Promise<void> {
  const topic = topicDefinition(canonicalTopicId(label) ?? "");
  const [tag] = await db.select().from(tags).where(eq(tags.label, topic?.label ?? label.trim().toLowerCase()));
  if (tag) {
    await db.delete(itemTags).where(and(eq(itemTags.itemId, id), eq(itemTags.tagId, tag.id)));
    await db.insert(itemTagOverrides).values({ itemId: id, tagId: tag.id, override: "suppressed", createdAt: Math.floor(Date.now() / 1000) }).onConflictDoUpdate({ target: [itemTagOverrides.itemId, itemTagOverrides.tagId], set: { override: "suppressed", createdAt: Math.floor(Date.now() / 1000) } });
  }
}

export async function listCollections(db: AnansiDb): Promise<Collection[]> {
  return (await db.select().from(collections).orderBy(collections.name)).map((row) => ({ ...row, filters: JSON.parse(row.filters) as CollectionFilters }));
}

export async function saveCollection(db: AnansiDb, input: { id?: string; name: string; filters: CollectionFilters }): Promise<Collection> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error("Collection name must be 1–120 characters");
  // A saved view captures criteria, never transient pagination state.
  const { cursor: _cursor, limit: _limit, ...filters } = input.filters as ListOptions & { query?: string };
  const now = Math.floor(Date.now() / 1000);
  const id = input.id ?? crypto.randomUUID();
  await db.insert(collections).values({ id, name, filters: JSON.stringify(filters), createdAt: now, updatedAt: now }).onConflictDoUpdate({
    target: collections.id, set: { name, filters: JSON.stringify(filters), updatedAt: now },
  });
  const [row] = await db.select().from(collections).where(eq(collections.id, id));
  if (!row) throw new Error("Collection could not be saved");
  return { ...row, filters };
}

export async function deleteCollection(db: AnansiDb, id: string): Promise<void> {
  await db.delete(collections).where(eq(collections.id, id));
}

/** Portable logical backup. Media metadata is included; binary objects need a separate copy. */
export interface LibraryExport {
  format: "anansi-library";
  version: 1;
  exportedAt: string;
  items: (typeof items.$inferSelect)[];
  media: (typeof media.$inferSelect)[];
  highlights: (typeof highlights.$inferSelect)[];
  tags: (typeof tags.$inferSelect)[];
  itemTags: (typeof itemTags.$inferSelect)[];
  collections: (typeof collections.$inferSelect)[];
}

export async function exportLibrary(db: AnansiDb): Promise<LibraryExport> {
  const exportedItems = (await db.select().from(items)).filter((item) => !isHiddenSource(item.source));
  const ids = new Set(exportedItems.map((item) => item.id));
  return {
    format: "anansi-library", version: 1, exportedAt: new Date().toISOString(),
    items: exportedItems,
    media: (await db.select().from(media)).filter((row) => ids.has(row.itemId)),
    highlights: (await db.select().from(highlights)).filter((row) => ids.has(row.itemId)),
    tags: await db.select().from(tags),
    itemTags: (await db.select().from(itemTags)).filter((row) => ids.has(row.itemId)),
    collections: await db.select().from(collections),
  };
}

/** Restore into an empty library only; never overwrite a user's existing work. */
export async function restoreLibrary(db: AnansiDb, backup: LibraryExport): Promise<void> {
  if (backup?.format !== "anansi-library" || backup.version !== 1) throw new Error("Unsupported Anansi backup");
  const [count] = await db.select({ n: sql<number>`count(*)` }).from(items);
  if (Number(count?.n ?? 0) !== 0) throw new Error("Restore requires an empty library");
  await atomicWrite(db, (tx) => [
    // Small statements respect D1's binding limit and form one D1 batch.
    ...backup.items.map((row) => tx.insert(items).values(row)),
    ...backup.tags.map((row) => tx.insert(tags).values(row).onConflictDoNothing()),
    ...backup.itemTags.map((row) => tx.insert(itemTags).values(row)),
    ...backup.highlights.map((row) => tx.insert(highlights).values(row)),
    // Exported keys refer to a separate binary backup. Clearing them queues a
    // fresh download, rather than promising bytes this installation does not have.
    ...backup.media.map((row) => tx.insert(media).values({ ...row, storedKey: null })),
    ...backup.collections.map((row) => tx.insert(collections).values(row).onConflictDoNothing()),
  ]);
}
