import { eq, inArray, sql } from "drizzle-orm";
import { itemTags, items, media, sourceSettings, tags } from "./schema.ts";
import type { AnansiDb, NewDbItem } from "./types.ts";

/**
 * The shape the adapters produce. Structurally identical to the CLI's
 * NormalizedItem, restated here so packages/db does not depend on apps/cli —
 * the dependency runs one way, and later the Worker will import this too.
 */
export interface IngestItem {
  source: string;
  externalId: string;
  url: string;
  kind: string;
  authorHandle?: string;
  authorName?: string;
  authorAvatar?: string;
  title?: string;
  body: string;
  lang?: string;
  postedAt?: number;
  savedAt: number;
  savedAtIsExact: boolean;
  saveOrder?: number;
  metrics: Record<string, number>;
  media: { kind: string; originUrl: string; width?: number; height?: number }[];
  links: string[];
  raw: unknown;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  mediaRows: number;
}

/**
 * Idempotent on (source, external_id), because imports will run twice.
 *
 * Two details that matter on a re-run. The row's `id` is generated once and
 * never overwritten, so anything that referenced it still resolves. And
 * `saved_at` is only allowed to move backwards, or toward being exact: a
 * backfill stamps import time, so letting a later backfill overwrite an
 * earlier one would march every item's saved date forward every time you
 * re-import.
 */
/**
 * Idempotent on (source, external_id), because imports will run twice.
 *
 * Shape matters here. The obvious loop — select, insert, delete media, insert
 * media, per item — is ~5,000 statements for this library and took 18s, and a
 * transaction did not help because the cost is per-statement ORM overhead, not
 * fsync. So: one read of the existing keys, all the decisions made in memory,
 * then chunked bulk writes.
 *
 * Two details that matter on a re-run. A row's `id` is generated once and
 * never overwritten, so anything already referencing it still resolves. And
 * `saved_at` may only move backwards, or toward being exact — a backfill
 * stamps import time, so letting each re-import overwrite the last would march
 * every item's saved date forward forever.
 */
export async function upsertItems(db: AnansiDb, batch: IngestItem[]): Promise<UpsertResult> {
  if (batch.length === 0) return { inserted: 0, updated: 0, mediaRows: 0 };

  const existing = await db
    .select({
      id: items.id,
      source: items.source,
      externalId: items.externalId,
      savedAt: items.savedAt,
      savedAtExact: items.savedAtExact,
    })
    .from(items);

  const prior = new Map(existing.map((r) => [`${r.source}:${r.externalId}`, r]));

  /**
   * Media is replaced wholesale below, which is right for staleness — a post
   * that lost an image should not keep a phantom row. But a fresh uuid and a
   * null stored_key on every re-import would orphan every uploaded thumbnail
   * and re-download the library each time. So the identity and the upload
   * state are carried across, keyed by what actually identifies a media item:
   * its item and its origin url.
   */
  const priorMedia = new Map(
    (
      await db
        .select({
          id: media.id,
          itemId: media.itemId,
          originUrl: media.originUrl,
          storedKey: media.storedKey,
        })
        .from(media)
    ).map((m) => [`${m.itemId}|${m.originUrl}`, m]),
  );

  let inserted = 0;
  let updated = 0;
  const rows: NewDbItem[] = [];
  const mediaRows: (typeof media.$inferInsert)[] = [];

  for (const item of batch) {
    const was = prior.get(`${item.source}:${item.externalId}`);
    const id = was?.id ?? crypto.randomUUID();
    was ? updated++ : inserted++;

    const savedAt = was
      ? was.savedAtExact === 1
        ? was.savedAt
        : item.savedAtIsExact
          ? item.savedAt
          : Math.min(was.savedAt, item.savedAt)
      : item.savedAt;

    rows.push({
      id,
      source: item.source,
      externalId: item.externalId,
      url: item.url,
      kind: item.kind,
      authorHandle: item.authorHandle ?? null,
      authorName: item.authorName ?? null,
      authorAvatar: item.authorAvatar ?? null,
      title: item.title ?? null,
      body: item.body,
      lang: item.lang ?? null,
      postedAt: item.postedAt ?? null,
      savedAt,
      savedAtExact: item.savedAtIsExact || was?.savedAtExact === 1 ? 1 : 0,
      saveOrder: item.saveOrder ?? null,
      metrics: JSON.stringify(item.metrics),
      // links ride inside raw rather than earning a column: the spec's schema
      // has none, and they are read only when one item is opened. Folded in
      // here because the row shape drops every NormalizedItem field that has
      // no column, and get_item promises links.
      raw: JSON.stringify(
        item.raw && typeof item.raw === "object"
          ? { ...(item.raw as Record<string, unknown>), links: item.links }
          : { raw: item.raw, links: item.links },
      ),
    });

    for (const m of item.media) {
      if (!m.originUrl) continue;
      const seen = priorMedia.get(`${id}|${m.originUrl}`);
      mediaRows.push({
        id: seen?.id ?? crypto.randomUUID(),
        itemId: id,
        kind: m.kind,
        originUrl: m.originUrl,
        storedKey: seen?.storedKey ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
      });
    }
  }

  // 15 columns per row; 200 rows is 3,000 bound parameters, well inside
  // SQLite's limit and few enough statements that the overhead disappears.
  const CHUNK = 200;

  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(items)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [items.source, items.externalId],
          set: {
            url: sql`excluded.url`,
            kind: sql`excluded.kind`,
            authorHandle: sql`excluded.author_handle`,
            authorName: sql`excluded.author_name`,
            authorAvatar: sql`excluded.author_avatar`,
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            lang: sql`excluded.lang`,
            postedAt: sql`excluded.posted_at`,
            savedAt: sql`excluded.saved_at`,
            savedAtExact: sql`excluded.saved_at_exact`,
            // Keep the first key we ever saw. X's sortIndex is stable per
            // item, and sources without a real one (Reddit gives no saved-at)
            // derive theirs from listing position at import time — which must
            // not be renumbered by a later re-import.
            saveOrder: sql`coalesce(${items.saveOrder}, excluded.save_order)`,
            // Never resurrect something you archived: a re-import refreshes
            // the content, not your decision about it.
            archivedAt: sql`${items.archivedAt}`,
            metrics: sql`excluded.metrics`,
            raw: sql`excluded.raw`,
          },
        });
    }

    // Media is replaced wholesale per item: cheap at this size, and it means
    // a post that lost an image does not keep a phantom row forever.
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      await tx.delete(media).where(inArray(media.itemId, ids.slice(i, i + CHUNK)));
    }
    for (let i = 0; i < mediaRows.length; i += CHUNK) {
      await tx.insert(media).values(mediaRows.slice(i, i + CHUNK)).onConflictDoNothing();
    }
  });

  return { inserted, updated, mediaRows: mediaRows.length };
}

export async function countItems(db: AnansiDb): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(items);
  return row?.n ?? 0;
}

/**
 * Creators is a group-by, not a table.
 *
 * `max(author_name)` and `max(author_avatar)` are not aggregates anyone means
 * literally — they pick one non-null value per handle, which is what you want
 * when a display name changed between two saves.
 */
export async function creators(db: AnansiDb, limit = 20) {
  return db.all<{
    authorHandle: string;
    authorName: string | null;
    authorAvatar: string | null;
    source: string;
    saves: number;
    lastPosted: number | null;
  }>(sql`
    select author_handle as authorHandle,
           max(author_name) as authorName,
           max(author_avatar) as authorAvatar,
           max(source) as source,
           count(*) as saves,
           max(posted_at) as lastPosted
    from items
    where author_handle is not null
    group by author_handle
    order by saves desc
    limit ${limit}
  `);
}

/**
 * Archive and tag, the two things select mode does.
 *
 * Both are set-shaped rather than per-item: selecting forty cards and issuing
 * forty round trips is how a bulk action becomes slow enough that people stop
 * using it.
 */
export async function setArchived(
  db: AnansiDb,
  ids: string[],
  archived: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  const at = archived ? Math.floor(Date.now() / 1000) : null;
  for (let i = 0; i < ids.length; i += 200) {
    await db.update(items).set({ archivedAt: at }).where(inArray(items.id, ids.slice(i, i + 200)));
  }
  return ids.length;
}

/**
 * Tags have existed in the schema since the first migration and nothing has
 * ever written to them. This is what fills them.
 */
export async function tagItems(db: AnansiDb, ids: string[], label: string): Promise<number> {
  const clean = label.trim().toLowerCase();
  if (ids.length === 0 || !clean) return 0;

  const existing = await db.select({ id: tags.id }).from(tags).where(eq(tags.label, clean)).limit(1);
  const tagId = existing[0]?.id ?? crypto.randomUUID();
  if (!existing[0]) {
    await db.insert(tags).values({ id: tagId, label: clean, origin: "manual" }).onConflictDoNothing();
  }

  for (let i = 0; i < ids.length; i += 200) {
    await db
      .insert(itemTags)
      .values(ids.slice(i, i + 200).map((itemId) => ({ itemId, tagId })))
      .onConflictDoNothing();
  }
  return ids.length;
}

/** Tags that exist, with how many items carry each. */
export async function listTags(db: AnansiDb) {
  return db.all<{ label: string; count: number }>(sql`
    select t.label as label, count(it.item_id) as count
    from tags t left join item_tags it on it.tag_id = t.id
    group by t.id order by count desc, t.label asc
  `);
}

/** Sources switched off. Absence means enabled, so this is the exception list. */
export async function disabledSources(db: AnansiDb): Promise<string[]> {
  const rows = await db
    .select({ source: sourceSettings.source })
    .from(sourceSettings)
    .where(eq(sourceSettings.enabled, 0));
  return rows.map((r) => r.source);
}

export async function setSourceEnabled(
  db: AnansiDb,
  source: string,
  enabled: boolean,
): Promise<void> {
  const row = {
    source,
    enabled: enabled ? 1 : 0,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await db.insert(sourceSettings).values(row).onConflictDoUpdate({
    target: sourceSettings.source,
    set: { enabled: row.enabled, updatedAt: row.updatedAt },
  });
}
