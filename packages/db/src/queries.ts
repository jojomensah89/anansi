import { and, eq, inArray, or, sql } from "drizzle-orm";
import { highlights, itemTagOverrides, itemTags, items, media, sourceSettings, tags } from "./schema.ts";
import type { AnansiDb, NewDbItem } from "./types.ts";
import { atomicWrite, type AtomicStatement } from "./atomic.ts";
import { visibleSourceClause } from "./visibility.ts";

export type CaptureOrigin =
  | "platform_event"
  | "platform_import"
  | "toolbar"
  | "context_menu"
  | "chrome_bookmark"
  | "legacy_unknown";

export interface UpsertOptions {
  /** Set only when an item is first inserted. */
  captureOrigin?: CaptureOrigin;
}

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

export async function upsertItems(
  db: AnansiDb,
  batch: IngestItem[],
  options: UpsertOptions = {},
): Promise<UpsertResult> {
  if (batch.length === 0) return { inserted: 0, updated: 0, mediaRows: 0 };
  const plan = await prepareUpsertItems(db, batch, options);
  await atomicWrite(db, plan.statements);
  return plan.result;
}

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
export interface UpsertPlan {
  result: UpsertResult;
  itemIds: Map<string, string>;
  statements(db: AnansiDb): AtomicStatement[];
}

export async function prepareUpsertItems(
  db: AnansiDb,
  batch: IngestItem[],
  options: UpsertOptions = {},
): Promise<UpsertPlan> {

  const selectionCaptures = batch.flatMap((item) => {
    const raw = objectValue(item.raw);
    return item.source === "web" && typeof raw.selection === "string" && raw.selection.trim()
      ? [{ key: `${item.source}:${item.externalId}`, text: raw.selection.trim(), createdAt: item.savedAt }] : [];
  });
  const combined = new Map<string, IngestItem>();
  for (const item of batch) {
    const key = `${item.source}:${item.externalId}`;
    const first = combined.get(key);
    if (!first) combined.set(key, item);
    else combined.set(key, { ...first, ...item, body: longer(first.body, item.body) ?? "",
      raw: mergeUseful(objectValue(first.raw), objectValue(item.raw)),
      media: [...first.media, ...item.media], links: [...new Set([...first.links, ...item.links])],
      savedAt: first.savedAtIsExact ? first.savedAt : item.savedAtIsExact ? item.savedAt : Math.min(first.savedAt, item.savedAt),
      savedAtIsExact: first.savedAtIsExact || item.savedAtIsExact });
  }
  batch = [...combined.values()];
  // Bound reads to incoming identities, never scan the whole library per capture.
  const existing: (typeof items.$inferSelect)[] = [];
  for (let start = 0; start < batch.length; start += 40) {
    const predicates = batch.slice(start, start + 40).map((item) =>
      and(eq(items.source, item.source), eq(items.externalId, item.externalId)));
    existing.push(...await db.select().from(items).where(or(...predicates)));
  }
  const prior = new Map(existing.map((r) => [`${r.source}:${r.externalId}`, r]));
  let inserted = 0;
  let updated = 0;
  const rows: NewDbItem[] = [];
  const mediaRows: (typeof media.$inferInsert)[] = [];
  const highlightRows: (typeof highlights.$inferInsert)[] = [];

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

    const oldRaw = objectJson(was?.raw);
    const newRaw = objectValue(item.raw);
    const shallow = options.captureOrigin === "chrome_bookmark";
    const keepRich = !!was && shallow && (was.captureOrigin !== "chrome_bookmark" || !!was.articleText || typeof oldRaw.capturedBy === "string");
    const mergedRaw = mergeUseful(oldRaw, { ...newRaw, links: item.links });
    const articleText = longer(was?.articleText, typeof newRaw.text === "string" ? newRaw.text : undefined);
    for (const selection of selectionCaptures.filter((capture) => capture.key === `${item.source}:${item.externalId}`)) {
      highlightRows.push({ id: crypto.randomUUID(), itemId: id, text: selection.text, createdAt: selection.createdAt });
    }
    rows.push({
      id,
      source: item.source,
      externalId: item.externalId,
      url: item.url,
      kind: item.kind,
      authorHandle: (keepRich ? was?.authorHandle : item.authorHandle) || was?.authorHandle || null,
      authorName: (keepRich ? was?.authorName : item.authorName) || was?.authorName || null,
      authorAvatar: item.authorAvatar || was?.authorAvatar || null,
      title: (keepRich ? was?.title : item.title) || was?.title || null,
      body: keepRich ? was!.body : shallow ? item.body : longer(was?.body, item.body),
      articleText,
      articleFormat: articleText === was?.articleText ? was.articleFormat : newRaw.articleFormat === "markdown" ? "markdown" : "plain",
      contentTruncated: articleText === was?.articleText ? was.contentTruncated : newRaw.contentTruncated === true ? 1 : 0,
      lang: item.lang || was?.lang || null,
      postedAt: item.postedAt ?? was?.postedAt ?? null,
      savedAt,
      savedAtExact: item.savedAtIsExact || was?.savedAtExact === 1 ? 1 : 0,
      captureOrigin: options.captureOrigin ?? "legacy_unknown",
      saveOrder: item.saveOrder ?? null,
      metrics: JSON.stringify({ ...objectJson(was?.metrics), ...item.metrics }),
      // links ride inside raw rather than earning a column: the spec's schema
      // has none, and they are read only when one item is opened. Folded in
      // here because the row shape drops every NormalizedItem field that has
      // no column, and get_item promises links.
      raw: JSON.stringify(mergedRaw),
    });

    for (const m of item.media) {
      if (!m.originUrl) continue;
      mediaRows.push({
        id: crypto.randomUUID(),
        itemId: id,
        kind: m.kind,
        originUrl: m.originUrl,
        storedKey: null,
        width: m.width ?? null,
        height: m.height ?? null,
      });
    }
  }

  // D1 allows at most 100 bound values per statement. Item rows have 27 columns.
  const CHUNK = 3;

  const statements = (target: AnansiDb): AtomicStatement[] => {
    const pending: AtomicStatement[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      pending.push(target
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
          articleText: sql`excluded.article_text`,
          articleFormat: sql`excluded.article_format`,
          contentTruncated: sql`excluded.content_truncated`,
          lang: sql`excluded.lang`,
          postedAt: sql`excluded.posted_at`,
          savedAt: sql`excluded.saved_at`,
          savedAtExact: sql`excluded.saved_at_exact`,
          // Provenance describes first arrival, not the latest refresh.
          captureOrigin: sql`${items.captureOrigin}`,
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
        }));
    }

    // An absent remote attachment is not a deletion request. Preserve existing IDs,
    // downloaded keys and job state; only add newly discovered attachments.
    for (let i = 0; i < mediaRows.length; i += CHUNK) {
      pending.push(target.insert(media).values(mediaRows.slice(i, i + CHUNK)).onConflictDoNothing());
    }
    for (let i = 0; i < highlightRows.length; i += CHUNK) {
      pending.push(target.insert(highlights).values(highlightRows.slice(i, i + CHUNK)).onConflictDoNothing());
    }
    return pending;
  };

  return {
    result: { inserted, updated, mediaRows: mediaRows.length },
    itemIds: new Map(rows.map((row) => [`${row.source}:${row.externalId}`, row.id])),
    statements,
  };
}

export async function countItems(db: AnansiDb): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(items).where(visibleSourceClause(sql`${items.source}`));
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
    where author_handle is not null and ${visibleSourceClause(sql`source`)}
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

  const existing = await db.select({ id: tags.id, color: tags.color }).from(tags).where(eq(tags.label, clean)).limit(1);
  const tagId = existing[0]?.id ?? crypto.randomUUID();
  if (!existing[0]) {
    await db.insert(tags).values({ id: tagId, label: clean, color: randomTagColor(), origin: "manual" }).onConflictDoNothing();
  }

  for (let i = 0; i < ids.length; i += 200) {
    await db.delete(itemTagOverrides).where(and(inArray(itemTagOverrides.itemId, ids.slice(i, i + 200)), eq(itemTagOverrides.tagId, tagId)));
    await db
      .insert(itemTags)
      .values(ids.slice(i, i + 200).map((itemId) => ({ itemId, tagId })))
      .onConflictDoNothing();
  }
  return ids.length;
}

/** Tags that exist, with how many items carry each. */
export async function listTags(db: AnansiDb) {
  return db.all<{ label: string; color: string; count: number }>(sql`
    select t.label as label, t.color as color, count(it.item_id) as count
    from tags t left join item_tags it on it.tag_id = t.id
      and exists (select 1 from items visible_item where visible_item.id = it.item_id and ${visibleSourceClause(sql`visible_item.source`)})
    group by t.id order by count desc, t.label asc
  `);
}

const TAG_COLORS = [
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#14b8a6",
	"#06b6d4",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
] as const;

function randomTagColor(): (typeof TAG_COLORS)[number] {
	const random = new Uint32Array(1);
	crypto.getRandomValues(random);
	return TAG_COLORS[random[0]! % TAG_COLORS.length]!;
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function objectJson(value: string | null | undefined): Record<string, unknown> {
  try { return objectValue(JSON.parse(value ?? "{}")); } catch { return {}; }
}
function longer(previous: string | null | undefined, incoming: string | null | undefined): string | null {
  return (incoming?.trim().length ?? 0) >= (previous?.trim().length ?? 0) ? incoming || previous || null : previous || null;
}
/** Partial provider responses never clear useful fields; explicit user deletion is separate. */
function mergeUseful(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      const old = Array.isArray(previous[key]) ? previous[key] as unknown[] : [];
      result[key] = [...new Map([...old, ...value].map((v) => [JSON.stringify(v), v])).values()];
    } else if (typeof value === "object") result[key] = mergeUseful(objectValue(previous[key]), objectValue(value));
    else if (["text", "ownText", "readme", "description"].includes(key) && typeof value === "string")
      result[key] = longer(typeof previous[key] === "string" ? previous[key] as string : undefined, value);
    else result[key] = value;
  }
  return result;
}
