import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One items table, every source.
 *
 * Per-source tables are the tempting mistake: with one normalized row and the
 * platform payload preserved in `raw`, a new adapter is a parser rather than
 * a migration.
 *
 * There is no `user_id` column. This is a single-tenant library; the column
 * arrives when there is a second user, not in anticipation of one.
 *
 * Identical file locally and as D1 in production — only the driver changes.
 */
export const items = sqliteTable(
  "items",
  {
    /** uuid, generated in app code on first insert and stable across re-imports. */
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    /** tweet id | repo node id */
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    /** 'post' | 'repo' */
    kind: text("kind").notNull(),
    authorHandle: text("author_handle"),
    authorName: text("author_name"),
    title: text("title"),
    /** full_text with t.co expanded | repo description + README head */
    body: text("body"),
    lang: text("lang"),
    /** unix seconds; SQLite has no date type */
    postedAt: integer("posted_at"),
    savedAt: integer("saved_at").notNull(),
    /**
     * The one deviation from the spec's schema, and it earns its byte: the
     * bookmarks timeline returns no per-item saved-at, so backfill stamps
     * import time. When the extension starts watching CreateBookmark it will
     * produce real ones, and a query that cannot tell the two apart will
     * quietly lie about when you saved things.
     */
    savedAtExact: integer("saved_at_exact").notNull().default(0),
    /**
     * The timeline's own ordering key, and the only truthful answer to "what
     * did I save most recently?" while saved_at is a backfill stamp.
     *
     * Stored as a JS number despite exceeding 2^53: these run ~1.7-1.9e18
     * across 1,274 items, an average gap of 1.3e14, against a float ulp of
     * 256 at that magnitude. Nine orders of magnitude of headroom for an
     * ordering that never needs the exact value.
     */
    saveOrder: integer("save_order"),
    /** json: likes, retweets, stars */
    metrics: text("metrics").notNull().default("{}"),
    /** json: the untouched platform payload */
    raw: text("raw").notNull(),
  },
  (t) => [
    uniqueIndex("items_source_external").on(t.source, t.externalId),
    index("items_saved").on(t.savedAt),
    index("items_save_order").on(t.saveOrder),
    index("items_author").on(t.authorHandle),
  ],
);

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** 'image' | 'video_poster' | 'card' */
    kind: text("kind").notNull(),
    originUrl: text("origin_url").notNull(),
    /** R2 object key, null until fetched */
    storedKey: text("stored_key"),
    width: integer("width"),
    height: integer("height"),
  },
  (t) => [uniqueIndex("media_item_origin").on(t.itemId, t.originUrl)],
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  label: text("label").notNull().unique(),
  /** 'ai' | 'manual' */
  origin: text("origin").notNull(),
});

export const itemTags = sqliteTable(
  "item_tags",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

/**
 * Creators need no table — they are a view over author_handle. A `group by`
 * with a count is the Creators page, and it should stay that way until it
 * cannot be.
 */
export const creatorsQuery = sql`
  select author_handle, count(*) as saves, max(posted_at) as last_posted
  from items where author_handle is not null
  group by author_handle order by saves desc
`;
