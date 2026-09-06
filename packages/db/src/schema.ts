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
    authorAvatar: text("author_avatar"),
    title: text("title"),
    /** full_text with t.co expanded | repo description + README head */
    body: text("body"),
    /** Safe reader text; markup is never executed. */
    articleText: text("article_text"),
    articleFormat: text("article_format").notNull().default("plain"),
    contentTruncated: integer("content_truncated").notNull().default(0),
    searchText: text("search_text").notNull().default(""),
    note: text("note").notNull().default(""),
    favorite: integer("favorite").notNull().default(0),
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
    /** How this item first entered Anansi. Never rewritten by later refreshes. */
    captureOrigin: text("capture_origin").notNull().default("legacy_unknown"),
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
    /** Whether the item is still saved at its originating platform. */
    platformSaved: integer("platform_saved").notNull().default(1),
    /** Unix seconds when the source most recently reported an unsave. */
    removedFromSourceAt: integer("removed_from_source_at"),
    /** Unix seconds of the newest source-state event applied to this item. */
    lastSourceEventAt: integer("last_source_event_at"),
    /** json: likes, retweets, stars */
    metrics: text("metrics").notNull().default("{}"),
    /** json: the untouched platform payload */
    raw: text("raw").notNull(),
    /**
     * A flag, deliberately, and not a delete. Deleting a row would be undone
     * by the next import — it comes straight back — so the only thing that can
     * persist an "I am done with this" is a column the importer preserves.
     */
    archivedAt: integer("archived_at"),
  },
  (t) => [
    uniqueIndex("items_source_external").on(t.source, t.externalId),
    index("items_saved").on(t.savedAt),
    index("items_save_order").on(t.saveOrder),
    index("items_platform_saved").on(t.platformSaved),
    index("items_posted").on(t.postedAt),
    index("items_archived").on(t.archivedAt),
    index("items_author").on(t.authorHandle),
  ],
);

/** Durable idempotency receipts for extension capture events. */
export const captureEvents = sqliteTable(
  "capture_events",
  {
    eventId: text("event_id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id"),
    action: text("action").notNull(),
    /** The delivery path that produced this event. */
    captureMethod: text("capture_method").notNull().default("legacy_unknown"),
    observedAt: integer("observed_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(),
    receipt: text("receipt").notNull(),
  },
  (t) => [
    index("capture_events_source_observed").on(t.source, t.observedAt),
    index("capture_events_item").on(t.itemId),
  ],
);

/** One canonical web item can be represented by several Chrome bookmark nodes. */
export const itemSourceLinks = sqliteTable(
  "item_source_links",
  {
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    present: integer("present").notNull().default(1),
    observedAt: integer("observed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.externalId] }),
    index("item_source_links_item_present").on(t.itemId, t.present),
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
  /** A persisted accent chosen once when a tag is created. */
  color: text("color").notNull().default("#6b7280"),
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
    /** Assignment provenance is authoritative for AI suppression. */
    provenance: text("provenance").notNull().default("manual"),
    model: text("model"),
    appliedAt: integer("applied_at"),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

export const aiSettings = sqliteTable("ai_settings", {
  id: integer("id").primaryKey().default(1),
  semanticSearchEnabled: integer("semantic_search_enabled").notNull().default(0),
  autoTaggingEnabled: integer("auto_tagging_enabled").notNull().default(0),
  embeddingModel: text("embedding_model").notNull().default("@cf/baai/bge-small-en-v1.5"),
  embeddingDimensions: integer("embedding_dimensions").notNull().default(384),
  tagModel: text("tag_model").notNull().default("@cf/meta/llama-3.1-8b-instruct"),
  updatedAt: integer("updated_at").notNull().default(0),
  quotaPauseReason: text("quota_pause_reason"),
  lastRunAt: integer("last_run_at"),
});

export const aiEnrichmentJobs = sqliteTable(
  "ai_enrichment_jobs",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: integer("next_run_at").notNull().default(0),
    leaseUntil: integer("lease_until").notNull().default(0),
    claimToken: text("claim_token"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(0),
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (t) => [index("ai_enrichment_jobs_due").on(t.status, t.nextRunAt, t.leaseUntil), index("ai_enrichment_jobs_item").on(t.itemId)],
);

export const itemEmbeddings = sqliteTable("item_embeddings", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  vectorId: text("vector_id").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  contentHash: text("content_hash").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
  lastError: text("last_error"),
});

export const itemTagOverrides = sqliteTable(
  "item_tag_overrides",
  {
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
    override: text("override").notNull(),
    createdAt: integer("created_at").notNull().default(0),
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

/**
 * Per-source switches.
 *
 * A row per source rather than a column on items: this is configuration, not
 * data about a save, and it has to be readable by the extension config
 * endpoint without touching the library at all.
 *
 * A source with no row is enabled — absence means "not configured yet", which
 * is the right default for one you have just added.
 */
export const sourceSettings = sqliteTable("source_settings", {
  source: text("source").primaryKey(),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: integer("updated_at"),
});

export const highlights = sqliteTable("highlights", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("highlights_item_text").on(t.itemId, t.text)]);

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  filters: text("filters").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Last operational snapshot from each browser extension installation. */
export const extensionClients = sqliteTable(
  "extension_clients",
  {
    installationId: text("installation_id").primaryKey(),
    extensionVersion: text("extension_version").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    queue: text("queue").notNull(),
    sources: text("sources").notNull(),
  },
  (t) => [index("extension_clients_last_seen").on(t.lastSeenAt)],
);

export { mediaJobs } from "./media-jobs-schema.ts";
