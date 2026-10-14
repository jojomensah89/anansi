import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { D1_ATOMIC_STATEMENT_LIMIT } from "./d1.ts";
import { exportLibrary } from "./organization.ts";
import { validateRestoreBackup } from "./restore-preflight.ts";
import { abortLibraryRestore, finishLibraryRestore, getLibraryRestore, RESTORE_CHUNK_SIZE, RESTORE_TABLES, restoreCounts, startLibraryRestore, writeLibraryRestoreChunk } from "./restore.ts";
import { itemSourceLinks, itemTagOverrides, items, media, tags } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

const backupId = "a".repeat(64);

describe("resumable library restore", () => {
  test("restores over 40 rows in bounded atomic chunks and resumes after interruption", async () => {
    const source = openTestDb();
    for (let index = 0; index < 95; index++) {
      await source.insert(items).values({
        id: `item-${index}`, source: "web", externalId: `external-${index}`,
        url: `https://example.com/${index}`, kind: "article", savedAt: index + 1,
        saveOrder: index === 0 ? 1_800_000_000_000_000_000 : null,
        metrics: "{}", raw: "{}",
      });
    }
    await source.insert(media).values({ id: "image-1", itemId: "item-1", kind: "image", originUrl: "https://example.com/image.png", storedKey: "old-r2-key" });
    await source.insert(itemSourceLinks).values({ kind: "chrome_bookmark", externalId: "node-1", itemId: "item-1", present: 1, observedAt: 1 });
    const [topic] = await source.select().from(tags);
    await source.insert(itemTagOverrides).values({ itemId: "item-1", tagId: topic!.id, override: "suppressed", createdAt: 1 });
    const backup = await exportLibrary(source);
    expect(validateRestoreBackup(structuredClone(backup)).counts.items).toBe(95);
    const db = openTestDb();
    const counts = restoreCounts(backup);
    expect(RESTORE_CHUNK_SIZE + 2).toBeLessThan(D1_ATOMIC_STATEMENT_LIMIT);
    await startLibraryRestore(db, backupId, counts);
    await writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: backup.items.slice(0, RESTORE_CHUNK_SIZE) });
    expect((await startLibraryRestore(db, backupId, counts)).progress.items).toBe(30);
    await writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: backup.items.slice(0, RESTORE_CHUNK_SIZE) });
    await expect(writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: backup.items.slice(1, 31) })).rejects.toThrow("conflicts");
    await expect(finishLibraryRestore(db, backupId)).rejects.toThrow("incomplete");
    for (const table of RESTORE_TABLES) {
      let offset = (await getLibraryRestore(db))!.progress[table];
      const tableRows = backup[table] ?? [];
      while (offset < tableRows.length) {
        const rows = tableRows.slice(offset, offset + RESTORE_CHUNK_SIZE);
        await writeLibraryRestoreChunk(db, { backupId, table, offset, rows });
        offset += rows.length;
      }
    }
    expect((await finishLibraryRestore(db, backupId)).status).toBe("complete");
    expect((await exportLibrary(db)).items).toHaveLength(95);
    expect((await db.select().from(media).where(eq(media.id, "image-1")))[0]?.storedKey).toBeNull();
    expect(await db.select().from(itemSourceLinks)).toHaveLength(1);
    expect(await db.select().from(itemTagOverrides)).toHaveLength(1);
    await expect(startLibraryRestore(db, "b".repeat(64), counts)).rejects.toThrow("Another restore");
  });

  test("rejects nonempty target and out of order chunks", async () => {
    const db = openTestDb();
    const counts = { items: 2, tags: 0, itemTags: 0, itemTagOverrides: 0, itemSourceLinks: 0, highlights: 0, media: 0, collections: 0 };
    await startLibraryRestore(db, backupId, counts);
    const row = (id: string) => ({ id, source: "web", externalId: id, url: `https://example.com/${id}`, kind: "article", savedAt: 1, metrics: "{}", raw: "{}" });
    await expect(writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 1, rows: [row("x")] })).rejects.toThrow("order");
    await expect(writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: [row("x"), row("y"), row("z")] })).rejects.toThrow("order");
    await expect(writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: [{ id: "missing-required-fields" }] })).rejects.toThrow("Invalid restore chunk");
    const occupied = openTestDb();
    await occupied.insert(items).values({ id: "occupied", source: "web", externalId: "occupied", url: "https://example.com", kind: "article", savedAt: 1, metrics: "{}", raw: "{}" });
    await expect(startLibraryRestore(occupied, backupId, counts)).rejects.toThrow("empty library");
  });

  test("preflight accepts older exports and catches broken references", async () => {
    const source = openTestDb();
    const old = await exportLibrary(source) as unknown as Record<string, unknown>;
    delete old.itemTagOverrides;
    delete old.itemSourceLinks;
    expect(validateRestoreBackup(old).counts.itemSourceLinks).toBe(0);
    const broken = await exportLibrary(source) as unknown as Record<string, unknown>;
    broken.itemSourceLinks = [{ kind: "chrome_bookmark", externalId: "orphan", itemId: "missing", observedAt: 1 }];
    expect(() => validateRestoreBackup(broken)).toThrow("missing item");
    const invalidDefault = await exportLibrary(source) as unknown as Record<string, unknown>;
    (invalidDefault.tags as Record<string, unknown>[])[0]!.color = null;
    expect(() => validateRestoreBackup(invalidDefault)).toThrow("invalid fields");
  });

  test("abort before first chunk restores seed tags and permits a corrected backup", async () => {
    const db = openTestDb();
    const counts = { items: 1, tags: 0, itemTags: 0, itemTagOverrides: 0, itemSourceLinks: 0, highlights: 0, media: 0, collections: 0 };
    const initialTags = await db.select().from(tags);
    await startLibraryRestore(db, backupId, counts);
    await abortLibraryRestore(db, backupId);
    expect(await getLibraryRestore(db)).toBeNull();
    expect(await db.select().from(tags)).toEqual(initialTags);
    await expect(startLibraryRestore(db, backupId, counts)).rejects.toThrow("abandoned");
    expect((await startLibraryRestore(db, "b".repeat(64), counts)).backupId).toBe("b".repeat(64));
  });

  test("abort rejects after any restore row commits", async () => {
    const db = openTestDb();
    const counts = { items: 1, tags: 0, itemTags: 0, itemTagOverrides: 0, itemSourceLinks: 0, highlights: 0, media: 0, collections: 0 };
    await startLibraryRestore(db, backupId, counts);
    await writeLibraryRestoreChunk(db, { backupId, table: "items", offset: 0, rows: [{ id: "saved", source: "web", externalId: "saved", url: "https://example.com", kind: "article", savedAt: 1, metrics: "{}", raw: "{}" }] });
    await expect(abortLibraryRestore(db, backupId)).rejects.toThrow("already received data");
    expect((await getLibraryRestore(db))?.progress.items).toBe(1);
  });
});
