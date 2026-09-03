import { sql } from "drizzle-orm";
import type { AnansiDb } from "./types.ts";

/**
 * FTS5 query syntax is a real grammar, not a search box.
 *
 * `match` will throw on an unbalanced quote, a bare `*`, a stray `(`, or the
 * bare words AND / OR / NOT / NEAR. Since the input here comes from a person
 * typing, or worse from an agent composing a query, every term is quoted
 * before it is bound. Inside a double-quoted FTS5 string the only character
 * needing an escape is `"`, which is doubled.
 *
 * Two affordances are kept deliberately, because they are worth more than
 * the literal reading of the characters:
 *
 *   trailing *   prefix search — "embed*" matches embedding, embeddings
 *   "phrase"     an explicit phrase stays one phrase
 *
 * Everything else is literal. `-` does not mean NOT, and `AND` is the word
 * and, because that is what someone typing it into this tool means.
 */
export function toFtsQuery(input: string): string {
  const terms: string[] = [];
  // Quoted phrases first, then bare runs of non-space.
  const pattern = /"([^"]*)"|(\S+)/g;

  for (const m of input.matchAll(pattern)) {
    const phrase = m[1];
    const bare = m[2];

    if (phrase !== undefined) {
      const cleaned = phrase.trim();
      if (cleaned) terms.push(`"${cleaned.replaceAll('"', '""')}"`);
      continue;
    }
    if (bare === undefined) continue;

    const prefix = bare.endsWith("*");
    const word = (prefix ? bare.slice(0, -1) : bare).replaceAll('"', '""');
    if (!word) continue;
    terms.push(prefix ? `"${word}"*` : `"${word}"`);
  }

  // Implicit AND. An empty query would match everything, which is never what
  // was meant, so it matches nothing instead.
  return terms.join(" ");
}

export interface SearchOptions {
  query: string;
  source?: string;
  author?: string;
  /** unix seconds; posts newer than this */
  since?: number;
  limit?: number;
  /** Wrap each hit in the snippet. Defaults to nothing. */
  mark?: [string, string];
}

export interface CardMedia {
  key: string;
  kind: string;
  url: string;
}

export interface SearchHit {
  id: string;
  authorAvatar?: string | null;
  mediaCount?: number;
  url: string;
  author: string | null;
  authorName: string | null;
  title: string | null;
  excerpt: string;
  postedAt: number | null;
  savedAt: number;
  savedAtExact: number;
  source: string;
  score: number;
}

/**
 * Hybrid search is day-2-of-phase-2 work; this is keyword only, and honest
 * about it. Across 1,274 items dense with the exact jargon you would search
 * for, BM25 answers most questions correctly.
 *
 * `snippet()` is the detail that makes this good for an agent: it returns
 * context around the hit, already marked, which is exactly the excerpt shape
 * search_memory hands back. In Postgres you would assemble that yourself.
 */
export async function searchItems(db: AnansiDb, opts: SearchOptions): Promise<SearchHit[]> {
  const match = toFtsQuery(opts.query);
  if (!match) return [];

  const [open, close] = opts.mark ?? ["", ""];
  const limit = opts.limit ?? 10;

  const rows = await db.all<SearchHit>(sql`
    select
      i.id            as id,
      i.url           as url,
      i.author_handle as author,
      i.author_name   as authorName,
      i.title         as title,
      i.posted_at     as postedAt,
      i.saved_at      as savedAt,
      i.saved_at_exact as savedAtExact,
      i.source        as source,
      snippet(items_fts, 0, ${open}, ${close}, '…', 20) as excerpt,
      bm25(items_fts, 1.0, 0.6, 0.4) as score
    from items_fts
    join items i on i.rowid = items_fts.rowid
    where items_fts match ${match}
      and (${opts.source ?? null} is null or i.source = ${opts.source ?? null})
      and (${opts.author ?? null} is null or i.author_handle = ${opts.author ?? null})
      and (${opts.since ?? null} is null or i.posted_at >= ${opts.since ?? null})
    order by score
    limit ${limit}
  `);

  return rows;
}

/** "What did I save this week?" */
export async function recentSaves(db: AnansiDb, source?: string, limit = 20) {
  return db.all<SearchHit>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
           i.title, i.posted_at as postedAt, i.saved_at as savedAt,
           i.saved_at_exact as savedAtExact, i.source,
           substr(coalesce(i.body, ''), 1, 300) as excerpt, 0 as score
    from items i
    where (${source ?? null} is null or i.source = ${source ?? null})
    -- save_order is the timeline's own key and the only truthful recency we
    -- have while saved_at is a backfill stamp. Items without one (GitHub
    -- stars, which have a real starred_at) fall through to saved_at.
    order by i.save_order desc nulls last, i.saved_at desc, i.posted_at desc
    limit ${limit}
  `);
}

/** "What has pontusab shown me about the AI SDK?" */
export async function findByAuthor(db: AnansiDb, handle: string, limit = 20) {
  return db.all<SearchHit>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
           i.title, i.posted_at as postedAt, i.saved_at as savedAt,
           i.saved_at_exact as savedAtExact, i.source,
           substr(coalesce(i.body, ''), 1, 300) as excerpt, 0 as score
    from items i
    where i.author_handle = ${handle} collate nocase
    order by i.posted_at desc
    limit ${limit}
  `);
}

export interface ItemDetail {
  id: string;
  url: string;
  source: string;
  author: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  title: string | null;
  fullText: string;
  postedAt: number | null;
  savedAt: number;
  savedAtExact: boolean;
  metrics: Record<string, number>;
  media: {
    kind: string;
    originUrl: string;
    /** Our stored copy. Null means it was never fetched; render nothing. */
    storedKey: string | null;
    width: number | null;
    height: number | null;
  }[];
  links: string[];
  /** The post this one quotes, if it quotes one. */
  quoted: {
    handle: string | null;
    name: string | null;
    avatar: string | null;
    text: string;
    url: string | null;
    media: { kind: string; originUrl: string; storedKey: string | null }[];
  } | null;
  /** Other saved posts from the same conversation, if any. */
  thread: { id: string; url: string; author: string | null; excerpt: string }[];
}

/**
 * The full object, called after a search to pull one thing into context.
 *
 * `raw` is deliberately not returned. The spec's sketch includes it, but a
 * single raw tweet payload is 5-15KB of nested JSON, and an agent that
 * fetched three of them would have spent its context on `__typename` fields.
 * Everything raw is actually consulted for — links, thread, media — is
 * extracted here instead.
 */
export async function getItem(db: AnansiDb, id: string): Promise<ItemDetail | null> {
  const rows = await db.all<{
    id: string; url: string; source: string; author: string | null; authorName: string | null;
    authorAvatar: string | null;
    title: string | null; body: string | null; postedAt: number | null; savedAt: number;
    savedAtExact: number; metrics: string; raw: string;
  }>(sql`
    select id, url, source, author_handle as author, author_name as authorName,
           author_avatar as authorAvatar,
           title, body, posted_at as postedAt, saved_at as savedAt,
           saved_at_exact as savedAtExact, metrics, raw
    from items where id = ${id} limit 1
  `);

  const row = rows[0];
  if (!row) return null;

  let parsed: {
    links?: string[];
    conversationId?: string;
    ownText?: string;
    quoted?: {
      handle: string | null; name: string | null; avatar: string | null;
      text: string; url: string | null; mediaUrls: string[];
    } | null;
  } = {};
  try {
    parsed = JSON.parse(row.raw) as typeof parsed;
  } catch {
    // A payload we cannot parse should cost the extras, not the item.
  }

  const mediaRows = await db.all<{
    kind: string; originUrl: string; storedKey: string | null;
    width: number | null; height: number | null;
  }>(sql`
    select kind, origin_url as originUrl, stored_key as storedKey, width, height
    from media where item_id = ${id}
  `);

  const quotedUrls = new Set(parsed.quoted?.mediaUrls ?? []);
  const conversationId = parsed.conversationId ?? null;
  const thread = conversationId
    ? await db.all<{ id: string; url: string; author: string | null; excerpt: string }>(sql`
        select id, url, author_handle as author, substr(coalesce(body,''), 1, 200) as excerpt
        from items
        where json_extract(raw, '$.conversationId') = ${conversationId}
          and id != ${id}
        limit 10
      `)
    : [];

  let metrics: Record<string, number> = {};
  try {
    metrics = JSON.parse(row.metrics) as Record<string, number>;
  } catch {
    /* metrics are decoration; never fail an item for them */
  }

  return {
    id: row.id,
    url: row.url,
    source: row.source,
    author: row.author,
    authorName: row.authorName,
    authorAvatar: row.authorAvatar,
    title: row.title,
    // The post's own words. `body` carries the folded quote for FTS, which
    // would read as a run-on if it reached the screen.
    fullText: parsed.ownText ?? row.body ?? "",
    postedAt: row.postedAt,
    savedAt: row.savedAt,
    savedAtExact: row.savedAtExact === 1,
    metrics,
    // A quote's images are stored on the parent row, so they are partitioned
    // back out by origin url rather than duplicated.
    media: mediaRows.filter((m) => !quotedUrls.has(m.originUrl)),
    links: parsed.links ?? [],
    quoted: parsed.quoted
      ? {
          handle: parsed.quoted.handle,
          name: parsed.quoted.name,
          avatar: parsed.quoted.avatar,
          text: parsed.quoted.text,
          url: parsed.quoted.url,
          media: mediaRows.filter((m) => quotedUrls.has(m.originUrl)),
        }
      : null,
    thread,
  };
}

/**
 * Archived items are out of the library unless you ask for them. The flag is
 * the whole point of Archive being a flag: the row is still there for search
 * to find when you go looking for it deliberately.
 */
function archiveClause(archived: boolean | undefined) {
  if (archived === true) return sql`and i.archived_at is not null`;
  return sql`and i.archived_at is null`;
}

function mediaClause(media: string | undefined) {
  if (media === "none") return sql`and not exists (select 1 from media m where m.item_id = i.id)`;
  if (media === "any") return sql`and exists (select 1 from media m where m.item_id = i.id)`;
  if (media === "image")
    return sql`and exists (select 1 from media m where m.item_id = i.id and m.kind = 'image')`;
  if (media === "video")
    return sql`and exists (select 1 from media m where m.item_id = i.id and m.kind = 'video_poster')`;
  return sql``;
}

/**
 * Content type is derived, not stored.
 *
 * It is a different question per source — a Reddit save can be a comment and a
 * GitHub star never is — so it is computed from what each source actually
 * recorded rather than flattened into a column that would need backfilling
 * every time a source is added.
 */
function typeClause(type: string | undefined) {
  switch (type) {
    case "video":
      return sql`and exists (select 1 from media m where m.item_id = i.id and m.kind = 'video_poster')`;
    case "article":
      return sql`and json_array_length(coalesce(json_extract(i.raw, '$.links'), '[]')) > 0`;
    case "comment":
      return sql`and json_extract(i.raw, '$.isComment') = 1`;
    case "repo":
      return sql`and i.kind = 'repo'`;
    case "thread":
      return sql`and json_extract(i.raw, '$.inReplyToStatusId') is not null`;
    case "post":
      return sql`and i.kind = 'post'
                 and not exists (select 1 from media m
                                  where m.item_id = i.id and m.kind = 'video_poster')`;
    default:
      return sql``;
  }
}

export type ListOrder = "saved" | "posted";

export interface ListOptions {
  /**
   * Opaque, and shaped by `order`. Saved order carries a save_order; posted
   * order carries "postedAt.id", because two posts can share a second and a
   * cursor that cannot break that tie drops or repeats items at every page
   * boundary it lands on.
   */
  cursor?: string;
  source?: string;
  author?: string;
  limit?: number;
  /** "any" | "image" | "video" | "none" */
  media?: string;
  /** post | video | article | comment | repo | thread */
  contentType?: string;
  tag?: string;
  /** Archived items are excluded unless asked for. */
  archived?: boolean;
  /** Bookmark order by default; "posted" is chronological by the post's date. */
  order?: ListOrder;
}

/**
 * The grid's query. Keyset pagination on save_order rather than offset,
 * because offset pagination silently drops or repeats items whenever the set
 * changes underneath it — and an importer running while someone scrolls is
 * exactly that.
 */
export async function listItems(db: AnansiDb, opts: ListOptions = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const posted = opts.order === "posted";

  /**
   * Keyset paging in whichever order was asked for.
   *
   * `coalesce(posted_at, 0)` rather than `nulls last`: an undated item has to
   * sit at one consistent end for the cursor comparison to stay total, and a
   * source without a posted date (a Reddit save has one, a future source may
   * not) would otherwise fall out of paging entirely.
   */
  const [cursorAt, cursorId] = posted
    ? [Number(opts.cursor?.split(".")[0] ?? NaN), opts.cursor?.split(".").slice(1).join(".") ?? ""]
    : [Number(opts.cursor ?? NaN), ""];
  const hasCursor = Number.isFinite(cursorAt);

  const keyset = posted
    ? hasCursor
      ? sql`and (coalesce(i.posted_at, 0) < ${cursorAt}
                 or (coalesce(i.posted_at, 0) = ${cursorAt} and i.id > ${cursorId}))`
      : sql``
    : hasCursor
      ? sql`and i.save_order < ${cursorAt}`
      : sql``;

  const ordering = posted
    ? sql`order by coalesce(i.posted_at, 0) desc, i.id asc`
    : sql`order by i.save_order desc nulls last, i.saved_at desc`;

  const rows = await db.all<SearchHit & { saveOrder: number | null }>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
           i.author_avatar as authorAvatar,
           i.title, i.posted_at as postedAt, i.saved_at as savedAt,
           i.saved_at_exact as savedAtExact, i.source, i.save_order as saveOrder,
           substr(coalesce(json_extract(i.raw, '$.ownText'), i.body, ''), 1, 300) as excerpt,
           0 as score,
           -- Every stored image, not one representative. A card that shows
           -- one of four is a card that misrepresents the post. Stored keys
           -- only, so the grid never hot-links the platform.
           (select json_group_array(json_object('key', m.stored_key, 'kind', m.kind, 'url', m.origin_url))
              from media m where m.item_id = i.id and m.stored_key is not null) as mediaJson,
           (select count(*) from media m where m.item_id = i.id) as mediaCount,
           json_extract(i.raw, '$.quoted') as quotedJson,
           i.metrics as metricsJson
    from items i
    where (${opts.source ?? null} is null or i.source = ${opts.source ?? null})
      and (${opts.author ?? null} is null or i.author_handle = ${opts.author ?? null})
      ${keyset}
      and (${opts.tag ?? null} is null or exists (
            select 1 from item_tags it join tags t on t.id = it.tag_id
             where it.item_id = i.id and t.label = ${opts.tag ?? null}))
      ${archiveClause(opts.archived)}
      ${mediaClause(opts.media)}
      ${typeClause(opts.contentType)}
    ${ordering}
    limit ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
    const { metricsJson, mediaJson, quotedJson, ...rest } = row as typeof row & {
      metricsJson?: string;
      mediaJson?: string;
      quotedJson?: string;
    };

    const parse = <T,>(text: string | undefined, fallback: T): T => {
      try {
        return (JSON.parse(text ?? "") as T) ?? fallback;
      } catch {
        // Decoration, all of it. A malformed blob costs the extras, not the row.
        return fallback;
      }
    };

    const all = parse<{ key: string; kind: string; url: string }[]>(mediaJson, []);
    const quoted = parse<{
      handle: string | null; name: string | null; avatar: string | null;
      text: string; url: string | null; mediaUrls: string[];
    } | null>(quotedJson, null);

    // A quote's images live on the parent row; split them back apart so the
    // card can nest them where they belong.
    const quotedUrls = new Set(quoted?.mediaUrls ?? []);
    return {
      ...rest,
      metrics: parse<Record<string, number>>(metricsJson, {}),
      media: all.filter((m) => !quotedUrls.has(m.url)),
      quoted: quoted ? { ...quoted, media: all.filter((m) => quotedUrls.has(m.url)) } : null,
    };
  });
  const last = page.at(-1);
  const nextCursor = !hasMore || !last
    ? null
    : posted
      ? `${last.postedAt ?? 0}.${last.id}`
      : String(last.saveOrder ?? "");

  return { items: page, nextCursor };
}

/**
 * One round trip for everything the shell needs to render.
 *
 * Previously the sidebar asked four times — total, per source, and the author
 * list — which is how a sidebar ends up disagreeing with the page beside it.
 */
export async function libraryStats(db: AnansiDb) {
  // Archived items are excluded from the headline count, because the grid
  // excludes them: a sidebar that counts what the page does not show is a
  // sidebar you stop trusting.
  const [totals] = await db.all<{ items: number; authors: number; archived: number }>(sql`
    select sum(case when archived_at is null then 1 else 0 end) as items,
           count(distinct case when archived_at is null then author_handle end) as authors,
           sum(case when archived_at is null then 0 else 1 end) as archived
    from items
  `);
  const bySource = await db.all<{ source: string; n: number }>(sql`
    select source, count(*) as n from items where archived_at is null group by source
  `);
  const media = await db.all<{ total: number; stored: number }>(sql`
    select count(*) as total,
           sum(case when stored_key is null then 0 else 1 end) as stored
    from media
  `);
  return {
    items: totals?.items ?? 0,
    authors: totals?.authors ?? 0,
    archived: totals?.archived ?? 0,
    bySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])) as Record<string, number>,
    media: media[0] ?? { total: 0, stored: 0 },
  };
}

/**
 * Per-source health.
 *
 * `saved_at_exact` earns a second job here. It was added so a query could not
 * lie about when something was saved; it also happens to separate the two ways
 * an item can arrive — a backfill stamps import time, while the extension
 * watching CreateBookmark produces a real one. So the split between "imported"
 * and "captured live" falls out of a column that already exists rather than
 * needing a provenance field.
 */
export interface SourceHealth {
  source: string;
  items: number;
  captured: number;
  imported: number;
  authors: number;
  lastSavedAt: number | null;
  lastPostedAt: number | null;
  media: number;
  mediaStored: number;
}

export async function sourceHealth(db: AnansiDb): Promise<SourceHealth[]> {
  return db.all<SourceHealth>(sql`
    select
      i.source                                                    as source,
      count(*)                                                    as items,
      sum(case when i.saved_at_exact = 1 then 1 else 0 end)        as captured,
      sum(case when i.saved_at_exact = 0 then 1 else 0 end)        as imported,
      count(distinct i.author_handle)                              as authors,
      max(i.saved_at)                                              as lastSavedAt,
      max(i.posted_at)                                             as lastPostedAt,
      (select count(*) from media m
         join items mi on mi.id = m.item_id where mi.source = i.source) as media,
      (select count(*) from media m
         join items mi on mi.id = m.item_id
        where mi.source = i.source and m.stored_key is not null)   as mediaStored
    from items i
    group by i.source
    order by items desc
  `);
}
