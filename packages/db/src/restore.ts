import { eq, getTableColumns, sql } from "drizzle-orm";
import { atomicWrite } from "./atomic.ts";
import type { LibraryExport } from "./organization.ts";
import { collections, highlights, itemSourceLinks, itemTagOverrides, itemTags, items, media, restoreChunks, restoreRuns, tags } from "./schema.ts";
import { TOPIC_TAGS } from "./topics.ts";
import type { AnansiDb } from "./types.ts";

export const RESTORE_TABLES = ["items", "tags", "itemTags", "itemTagOverrides", "itemSourceLinks", "highlights", "media", "collections"] as const;
export type RestoreTable = (typeof RESTORE_TABLES)[number];
export type RestoreCounts = Record<RestoreTable, number>;
export const RESTORE_CHUNK_SIZE = 30;
export interface RestoreState {
  backupId: string;
  counts: RestoreCounts;
  progress: RestoreCounts;
  status: "active" | "complete";
}

const zeroCounts = (): RestoreCounts => ({ items: 0, tags: 0, itemTags: 0, itemTagOverrides: 0, itemSourceLinks: 0, highlights: 0, media: 0, collections: 0 });
const knownTable = (value: string): value is RestoreTable => RESTORE_TABLES.includes(value as RestoreTable);
const TABLE_SCHEMAS = { items, tags, itemTags, itemTagOverrides, itemSourceLinks, highlights, media, collections } as const;

function validRows(table: RestoreTable, rows: unknown[]): boolean {
  const columns = getTableColumns(TABLE_SCHEMAS[table]) as Record<string, { dataType: string; notNull: boolean; hasDefault: boolean }>;
  return rows.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    for (const [name, column] of Object.entries(columns)) {
      const value = row[name];
      if (value === undefined) {
        if (column.notNull && !column.hasDefault) return false;
        continue;
      }
      if (value === null) {
        if (column.notNull) return false;
        continue;
      }
      if (column.dataType === "string" && typeof value !== "string") return false;
      if (column.dataType === "number" && (typeof value !== "number" || !(name === "saveOrder" ? Number.isFinite(value) : Number.isSafeInteger(value)))) return false;
    }
    return Object.keys(row).every((key) => key in columns);
  });
}

export function restoreCounts(backup: LibraryExport): RestoreCounts {
  if (backup?.format !== "anansi-library" || backup.version !== 1) throw new Error("Unsupported Anansi backup");
  const counts = zeroCounts();
  for (const table of RESTORE_TABLES) {
    const rows = backup[table];
    if ((table === "itemTagOverrides" || table === "itemSourceLinks") && rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`Invalid ${table} backup rows`);
    counts[table] = rows.length;
  }
  return counts;
}

function validCounts(value: unknown): value is RestoreCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === RESTORE_TABLES.length && RESTORE_TABLES.every((table) => Number.isSafeInteger(object[table]) && (object[table] as number) >= 0 && (object[table] as number) <= 1_000_000);
}

function parseState(row: typeof restoreRuns.$inferSelect): RestoreState {
  const counts: unknown = JSON.parse(row.counts);
  const progress: unknown = JSON.parse(row.progress);
  if (!validCounts(counts) || !validCounts(progress) || (row.status !== "active" && row.status !== "complete")) throw new Error("Restore state is corrupt");
  return { backupId: row.backupId, counts, progress, status: row.status };
}

export async function getLibraryRestore(db: AnansiDb): Promise<RestoreState | null> {
  const [row] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, 1));
  return row ? parseState(row) : null;
}

/** Begin once, or return the durable cursor for the same backup after a retry. */
export async function startLibraryRestore(db: AnansiDb, backupId: string, counts: RestoreCounts): Promise<RestoreState> {
  if (!/^[a-f0-9]{64}$/.test(backupId)) throw new Error("Invalid backup identifier");
  if (!validCounts(counts)) throw new Error("Invalid backup counts");
  const existing = await getLibraryRestore(db);
  if (existing) {
    if (existing.backupId !== backupId || RESTORE_TABLES.some((table) => existing.counts[table] !== counts[table])) throw new Error("Another restore is already recorded");
    return existing;
  }
  // Aborted first-chunk receipts remain as race guards. Reusing the exact
  // abandoned file would collide with that guard and cannot begin safely.
  const [abandoned] = await db.select().from(restoreChunks).where(eq(restoreChunks.id, `${backupId}:first`));
  if (abandoned?.digest === "aborted") throw new Error("This backup was abandoned; select a corrected export");
  const [count] = await db.select({ n: sql<number>`count(*)` }).from(items);
  if (Number(count?.n ?? 0) !== 0) throw new Error("Restore requires an empty library");
  const [collectionCount] = await db.select({ n: sql<number>`count(*)` }).from(collections);
  if (Number(collectionCount?.n ?? 0) !== 0) throw new Error("Restore requires an empty library");
  const presentTags = await db.select().from(tags);
  if (presentTags.some((tag) => tag.origin !== "ai" || tag.kind !== "topic" || !tag.id.startsWith("topic:"))) throw new Error("Restore requires an empty library");
  const now = Math.floor(Date.now() / 1000);
  const state: RestoreState = { backupId, counts, progress: zeroCounts(), status: "active" };
  // Fresh databases seed canonical tags. Remove those before restoring the
  // backup's tag IDs so item_tags can still reference the exported IDs.
  await atomicWrite(db, (tx) => [
    tx.delete(tags),
    tx.insert(restoreRuns).values({ id: 1, backupId, counts: JSON.stringify(counts), progress: JSON.stringify(state.progress), status: "active", createdAt: now, updatedAt: now }),
  ]);
  return state;
}

async function rowDigest(rows: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Commit at most 30 rows plus a receipt and cursor update in one D1 batch. */
export async function writeLibraryRestoreChunk(db: AnansiDb, input: { backupId: string; table: RestoreTable; offset: number; rows: unknown[] }): Promise<RestoreState> {
  const { backupId, table, offset, rows } = input;
  if (!knownTable(table) || !Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(rows) || rows.length < 1 || rows.length > RESTORE_CHUNK_SIZE || !validRows(table, rows)) throw new Error("Invalid restore chunk");
  const state = await getLibraryRestore(db);
  if (!state || state.backupId !== backupId || state.status !== "active") throw new Error("No active restore for this backup");
  const digest = await rowDigest(rows);
  const firstTable = RESTORE_TABLES.find((name) => state.counts[name] > 0);
  const receiptId = table === firstTable && offset === 0 ? `${backupId}:first` : `${backupId}:${table}:${offset}`;
  if (offset < state.progress[table]) {
    const [receipt] = await db.select().from(restoreChunks).where(eq(restoreChunks.id, receiptId));
    if (receipt?.digest !== digest || receipt.rowCount !== rows.length) throw new Error("Restore chunk conflicts with an earlier upload");
    return state;
  }
  const firstIncomplete = RESTORE_TABLES.find((name) => state.progress[name] !== state.counts[name]);
  if (firstIncomplete !== table || offset !== state.progress[table] || offset + rows.length > state.counts[table]) throw new Error("Restore chunks must follow the backup order");
  const progress = { ...state.progress, [table]: offset + rows.length };
  const now = Math.floor(Date.now() / 1000);
  await atomicWrite(db, (tx) => [
    tx.insert(restoreChunks).values({ id: receiptId, backupId, tableName: table, offset, rowCount: rows.length, digest }),
    ...rows.map((row) => {
      switch (table) {
        case "items": return tx.insert(items).values(row as typeof items.$inferInsert);
        case "tags": return tx.insert(tags).values(row as typeof tags.$inferInsert);
        case "itemTags": return tx.insert(itemTags).values(row as typeof itemTags.$inferInsert);
        case "itemTagOverrides": return tx.insert(itemTagOverrides).values(row as typeof itemTagOverrides.$inferInsert);
        case "itemSourceLinks": return tx.insert(itemSourceLinks).values(row as typeof itemSourceLinks.$inferInsert);
        case "highlights": return tx.insert(highlights).values(row as typeof highlights.$inferInsert);
        // R2 objects are outside the JSON export. Never revive stale keys.
        case "media": return tx.insert(media).values({ ...(row as typeof media.$inferInsert), storedKey: null });
        case "collections": return tx.insert(collections).values(row as typeof collections.$inferInsert);
      }
    }),
    tx.update(restoreRuns).set({ progress: JSON.stringify(progress), updatedAt: now }).where(eq(restoreRuns.id, 1)),
  ]);
  return { ...state, progress };
}

/** Abandon only a session that has never committed a row. */
export async function abortLibraryRestore(db: AnansiDb, backupId: string): Promise<void> {
  const state = await getLibraryRestore(db);
  if (!state || state.backupId !== backupId || state.status !== "active") throw new Error("No active restore for this backup");
  if (RESTORE_TABLES.some((table) => state.progress[table] !== 0)) throw new Error("Restore has already received data; abort is unavailable");
  const [itemCount] = await db.select({ n: sql<number>`count(*)` }).from(items);
  const [collectionCount] = await db.select({ n: sql<number>`count(*)` }).from(collections);
  const [tagCount] = await db.select({ n: sql<number>`count(*)` }).from(tags);
  if (Number(itemCount?.n ?? 0) || Number(collectionCount?.n ?? 0) || Number(tagCount?.n ?? 0)) throw new Error("Library changed during restore; abort is unavailable");
  try {
    await atomicWrite(db, (tx) => [
      // The first chunk uses this same primary key. Whichever batch commits
      // first wins, so an abort can never silently erase a concurrent upload.
      tx.insert(restoreChunks).values({ id: `${backupId}:first`, backupId, tableName: "abort", offset: 0, rowCount: 0, digest: "aborted" }),
      tx.delete(restoreRuns).where(eq(restoreRuns.id, 1)),
      ...TOPIC_TAGS.map((topic) => tx.insert(tags).values({ id: topic.tagId, label: topic.label, color: topic.color, origin: "ai", kind: "topic" })),
    ]);
  } catch (error) {
    const latest = await getLibraryRestore(db);
    if (latest && RESTORE_TABLES.some((table) => latest.progress[table] !== 0)) throw new Error("Restore has already received data; abort is unavailable");
    throw error;
  }
}

export async function finishLibraryRestore(db: AnansiDb, backupId: string): Promise<RestoreState> {
  const state = await getLibraryRestore(db);
  if (!state || state.backupId !== backupId) throw new Error("No restore for this backup");
  if (state.status === "complete") return state;
  if (RESTORE_TABLES.some((table) => state.progress[table] !== state.counts[table])) throw new Error("Restore is incomplete");
  if (RESTORE_TABLES.every((table) => state.counts[table] === 0)) {
    await atomicWrite(db, (tx) => [
      tx.insert(restoreChunks).values({ id: `${backupId}:first`, backupId, tableName: "finish", offset: 0, rowCount: 0, digest: "empty-complete" }),
      tx.update(restoreRuns).set({ status: "complete", updatedAt: Math.floor(Date.now() / 1000) }).where(eq(restoreRuns.id, 1)),
    ]);
  } else await db.update(restoreRuns).set({ status: "complete", updatedAt: Math.floor(Date.now() / 1000) }).where(eq(restoreRuns.id, 1));
  return { ...state, status: "complete" };
}
