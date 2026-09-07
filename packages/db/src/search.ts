import { sql, type SQL } from "drizzle-orm";
import type { AnansiDb } from "./types.ts";
import { visibleSourceClause } from "./visibility.ts";

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

export interface SearchOptions extends ListOptions {
  query: string;
  /** One value or several. Several means "is any of". */
  source?: string | string[];
  author?: string | string[];
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

export interface TagSummary {
	label: string;
	color: string;
}

export interface SearchHit {
  id: string;
  authorAvatar?: string | null;
  /** Primary repository language for GitHub list cards, when stored. */
  language?: string | null;
  /** Repository visibility, when GitHub supplied it. */
  visibility?: "public" | "private" | null;
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
  favorite?: boolean;
  media?: CardMedia[];
  metrics?: Record<string, number>;
  /**
   * 0 once the platform no longer has it saved.
   *
   * An unsave never deletes the item — the library keeps what you saved even
   * after the platform stops agreeing that you did — so this is the only way
   * anything downstream can tell the difference.
   */
  platformSaved?: number;
  removedFromSourceAt?: number | null;
  /** Lightweight organization metadata for library cards. */
  hasNote?: boolean;
  tags?: TagSummary[];
}

type SearchPageRow = Omit<SearchHit, "favorite" | "hasNote" | "tags"> & {
	favorite: number;
	mediaJson: string;
	metricsJson: string;
	tagsJson: string;
	hasNote: number;
};

type ListPageRow = Omit<SearchHit, "favorite" | "hasNote" | "tags"> & {
	saveOrder: number | null;
	favorite: number;
	mediaJson: string;
	metricsJson: string;
	quotedJson: string;
	tagsJson: string;
	hasNote: number;
};

/**
 * Hybrid search is day-2-of-phase-2 work; this is keyword only, and honest
 * about it. Across 1,274 items dense with the exact jargon you would search
 * for, BM25 answers most questions correctly.
 *
 * `snippet()` is the detail that makes this good for an agent: it returns
 * context around the hit, already marked, which is exactly the excerpt shape
 * search_memory hands back. In Postgres you would assemble that yourself.
 */
export class InvalidSearchCursorError extends Error {
  constructor() { super("invalid search cursor"); this.name = "InvalidSearchCursorError"; }
}

/** Relevance keyset cursor. Query/filter identity prevents accidental cross-query paging. */
export async function searchItemsPage(db: AnansiDb, opts: SearchOptions): Promise<{ items: SearchHit[]; nextCursor: string | null }> {
  const match = toFtsQuery(opts.query);
  if (!match) return { items: [], nextCursor: null };
  const [open, close] = opts.mark ?? ["", ""];
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
  const key = JSON.stringify([match, opts.source, opts.author, opts.tag, opts.media, opts.contentType, opts.archived ?? false, opts.removed ?? "include", opts.favorite, opts.since]);
  let afterScore = 0;
  let afterId = "";
  if (opts.cursor) {
    try {
      const cursor = JSON.parse(decodeURIComponent(opts.cursor));
      if (cursor.key !== key || typeof cursor.score !== "number" || !Number.isFinite(cursor.score) || typeof cursor.id !== "string" || !cursor.id) throw new Error();
      afterScore = cursor.score; afterId = cursor.id;
    } catch { throw new InvalidSearchCursorError(); }
  }
  const rows = await db.all<SearchPageRow>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
      i.author_avatar as authorAvatar, i.title, i.posted_at as postedAt,
      i.saved_at as savedAt, i.saved_at_exact as savedAtExact, i.source,
      i.platform_saved as platformSaved, i.removed_from_source_at as removedFromSourceAt,
      i.favorite, i.metrics as metricsJson,
      json_extract(i.raw, '$.language') as language,
      json_extract(i.raw, '$.visibility') as visibility,
      (select count(*) from media m where m.item_id=i.id) as mediaCount,
      (select json_group_array(json_object('key',m.stored_key,'kind',m.kind,'url',m.origin_url)) from media m where m.item_id=i.id and m.stored_key is not null) as mediaJson,
      (select json_group_array(json_object('label',t.label,'color',t.color)) from item_tags it join tags t on t.id=it.tag_id where it.item_id=i.id) as tagsJson,
      case when length(coalesce(i.note, '')) > 0 then 1 else 0 end as hasNote,
      snippet(items_fts, -1, ${open}, ${close}, '…', 28) as excerpt,
      bm25(items_fts, 1.0, 2.0, 0.4, 1.0, 1.5) as score
    from items_fts join items i on i.rowid = items_fts.rowid
    where items_fts match ${match}
      and ${visibleSourceClause(sql`i.source`)}
      ${anyOf(sql`i.source`, opts.source)}
      ${anyOf(sql`i.author_handle`, opts.author)}
      ${tagClause(opts.tag)} ${archiveClause(opts.archived)}
      ${removedClause(opts.removed)} ${mediaClause(opts.media)} ${typeClause(opts.contentType)}
      ${opts.favorite === undefined ? sql`` : sql`and i.favorite = ${opts.favorite ? 1 : 0}`}
      and (${opts.since ?? null} is null or i.posted_at >= ${opts.since ?? null})
      ${opts.cursor ? sql`and (bm25(items_fts,1.0,2.0,0.4,1.0,1.5) > ${afterScore} or (bm25(items_fts,1.0,2.0,0.4,1.0,1.5) = ${afterScore} and i.id > ${afterId}))` : sql``}
    order by score asc, i.id asc limit ${limit + 1}
  `);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((rawRow) => {
		return {
			id: rawRow.id,
			url: rawRow.url,
			author: rawRow.author,
			authorName: rawRow.authorName,
			authorAvatar: rawRow.authorAvatar,
			language: rawRow.language,
			visibility: rawRow.visibility,
			title: rawRow.title,
			postedAt: rawRow.postedAt,
			savedAt: rawRow.savedAt,
			savedAtExact: rawRow.savedAtExact,
			source: rawRow.source,
			platformSaved: rawRow.platformSaved,
			removedFromSourceAt: rawRow.removedFromSourceAt,
			favorite: rawRow.favorite === 1,
			mediaCount: rawRow.mediaCount,
			excerpt: rawRow.excerpt,
			score: rawRow.score,
			hasNote: rawRow.hasNote === 1,
			tags: parseTagSummary(rawRow.tagsJson),
			media: JSON.parse(rawRow.mediaJson ?? "[]") as CardMedia[],
			metrics: JSON.parse(rawRow.metricsJson ?? "{}") as Record<string, number>,
		};
	});
  const last = page.at(-1);
  return { items: page, nextCursor: hasMore && last ? encodeURIComponent(JSON.stringify({ key, score: last.score, id: last.id })) : null };
}

/** Compatibility for MCP and existing quick-search clients. */
export async function searchItems(db: AnansiDb, opts: SearchOptions): Promise<SearchHit[]> {
  return (await searchItemsPage(db, { ...opts, limit: opts.limit ?? 10 })).items;
}

/**
 * Hydrate IDs returned by a semantic index through the same D1 predicates as
 * keyword search. Vector metadata is never an authorization or visibility
 * decision; this query is the authority for the returned card.
 */
export async function hydrateSearchItems(
  db: AnansiDb,
  ids: string[],
  opts: Omit<SearchOptions, "query" | "cursor" | "mark">,
): Promise<SearchHit[]> {
  const uniqueIds = [...new Set(ids)].filter(Boolean).slice(0, 100);
  if (uniqueIds.length === 0) return [];
  type Row = Omit<SearchHit, "favorite" | "hasNote" | "tags"> & {
    favorite: number; mediaJson: string; metricsJson: string; tagsJson: string; hasNote: number;
  };
  const rows = await db.all<Row>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
      i.author_avatar as authorAvatar, i.title, i.posted_at as postedAt,
      i.saved_at as savedAt, i.saved_at_exact as savedAtExact, i.source,
      i.platform_saved as platformSaved, i.removed_from_source_at as removedFromSourceAt,
      i.favorite, i.metrics as metricsJson,
      json_extract(i.raw, '$.language') as language,
      json_extract(i.raw, '$.visibility') as visibility,
      (select count(*) from media m where m.item_id=i.id) as mediaCount,
      (select json_group_array(json_object('key',m.stored_key,'kind',m.kind,'url',m.origin_url))
         from media m where m.item_id=i.id and m.stored_key is not null) as mediaJson,
      (select json_group_array(json_object('label',t.label,'color',t.color))
         from item_tags it join tags t on t.id=it.tag_id where it.item_id=i.id) as tagsJson,
      case when length(coalesce(i.note, '')) > 0 then 1 else 0 end as hasNote,
      substr(coalesce(json_extract(i.raw, '$.ownText'), i.body, ''), 1, 300) as excerpt,
      0 as score
    from items i
    where i.id in (${sql.join(uniqueIds.map((id) => sql`${id}`), sql`, `)})
      and ${visibleSourceClause(sql`i.source`)}
      ${anyOf(sql`i.source`, opts.source)}
      ${anyOf(sql`i.author_handle`, opts.author)}
      ${tagClause(opts.tag)} ${archiveClause(opts.archived)}
      ${removedClause(opts.removed)} ${mediaClause(opts.media)} ${typeClause(opts.contentType)}
      ${opts.favorite === undefined ? sql`` : sql`and i.favorite = ${opts.favorite ? 1 : 0}`}
      and (${opts.since ?? null} is null or i.posted_at >= ${opts.since ?? null})
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return uniqueIds.flatMap((id) => {
    const rawRow = byId.get(id);
    if (!rawRow) return [];
    const parse = <T,>(text: string | undefined, fallback: T): T => {
      try { return (JSON.parse(text ?? "") as T) ?? fallback; } catch { return fallback; }
    };
    return [{
      id: rawRow.id, url: rawRow.url, author: rawRow.author, authorName: rawRow.authorName,
      authorAvatar: rawRow.authorAvatar, language: rawRow.language, visibility: rawRow.visibility,
      title: rawRow.title, postedAt: rawRow.postedAt, savedAt: rawRow.savedAt,
      savedAtExact: rawRow.savedAtExact, source: rawRow.source, platformSaved: rawRow.platformSaved,
      removedFromSourceAt: rawRow.removedFromSourceAt, favorite: rawRow.favorite === 1,
      mediaCount: rawRow.mediaCount, excerpt: rawRow.excerpt, score: rawRow.score,
      hasNote: rawRow.hasNote === 1, tags: parseTagSummary(rawRow.tagsJson),
      media: parse<CardMedia[]>(rawRow.mediaJson, []),
      metrics: parse<Record<string, number>>(rawRow.metricsJson, {}),
    } satisfies SearchHit];
  });
}

/** "What did I save this week?" */
export async function recentSaves(db: AnansiDb, source?: string, limit = 20) {
  return db.all<SearchHit>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
           i.title, i.posted_at as postedAt, i.saved_at as savedAt,
           i.saved_at_exact as savedAtExact, i.source,
           substr(coalesce(i.body, ''), 1, 300) as excerpt, 0 as score
    from items i
    where ${visibleSourceClause(sql`i.source`)}
      and (${source ?? null} is null or i.source = ${source ?? null})
    -- Source order keys are not globally comparable: X sort indexes, Reddit
    -- listing positions, and GitHub timestamps use different scales. Saved
    -- time orders sources; source order only breaks ties within an import.
    order by i.saved_at desc, coalesce(i.save_order, 0) desc, i.id asc
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
    where ${visibleSourceClause(sql`i.source`)}
      and i.author_handle = ${handle} collate nocase
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
  articleText: string | null;
  articleFormat: "plain" | "markdown";
  contentTruncated: boolean;
  highlights: { id: string; text: string; createdAt: number }[];
  note: string;
  favorite: boolean;
  tags: string[];
  tagMeta: TagSummary[];
  archived: boolean;
  postedAt: number | null;
  savedAt: number;
  savedAtExact: boolean;
  /** False once the platform no longer has it saved. Never a deletion. */
  platformSaved: boolean;
  removedFromSourceAt: number | null;
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
    savedAtExact: number; platformSaved: number; removedFromSourceAt: number | null;
    metrics: string; raw: string; articleText: string | null; articleFormat: string; contentTruncated: number; note: string; favorite: number; archivedAt: number | null;
  }>(sql`
    select id, url, source, author_handle as author, author_name as authorName,
           author_avatar as authorAvatar,
           platform_saved as platformSaved,
           removed_from_source_at as removedFromSourceAt,
           title, body, posted_at as postedAt, saved_at as savedAt,
           saved_at_exact as savedAtExact, metrics, raw, article_text as articleText, article_format as articleFormat, content_truncated as contentTruncated, note, favorite, archived_at as archivedAt
    from items where id = ${id} and ${visibleSourceClause(sql`source`)} limit 1
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
        where ${visibleSourceClause(sql`source`)}
          and json_extract(raw, '$.conversationId') = ${conversationId}
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
    fullText: row.articleText ?? parsed.ownText ?? row.body ?? "",
    articleText: row.articleText,
    articleFormat: row.articleFormat === "markdown" ? "markdown" : "plain",
    contentTruncated: row.contentTruncated === 1,
    highlights: await db.all<{id:string; text:string; createdAt:number}>(sql`select id,text,created_at as createdAt from highlights where item_id=${id} order by created_at,id`),
    note: row.note,
    favorite: row.favorite === 1,
    tags: (await db.all<{label:string}>(sql`select t.label from tags t join item_tags it on it.tag_id=t.id where it.item_id=${id} order by t.label`)).map(t => t.label),
    tagMeta: await db.all<TagSummary>(sql`select t.label, t.color from tags t join item_tags it on it.tag_id=t.id where it.item_id=${id} order by t.label`),
    archived: row.archivedAt !== null,
    postedAt: row.postedAt,
    savedAt: row.savedAt,
    savedAtExact: row.savedAtExact === 1,
    platformSaved: row.platformSaved !== 0,
    removedFromSourceAt: row.removedFromSourceAt ?? null,
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
 * One value, several, or none.
 *
 * A filter with nothing selected is not a filter matching nothing — it is an
 * absent filter. Returning an empty clause for an empty list is what makes
 * clearing the last value out of a chip behave the way the chip looks.
 */
function toList(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((v) => typeof v === "string" && v.length > 0))];
}

/** `is any of`, as SQL. Every value is bound; nothing is interpolated. */
function anyOf(column: SQL, value: string | string[] | undefined): SQL {
  const list = toList(value);
  if (list.length === 0) return sql``;
  return sql`and ${column} in (${sql.join(
    list.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

function tagClause(value: string | string[] | undefined): SQL {
  const list = toList(value);
  if (list.length === 0) return sql``;
  return sql`and exists (
    select 1 from item_tags it join tags t on t.id = it.tag_id
     where it.item_id = i.id and t.label in (${sql.join(
       list.map((v) => sql`${v}`),
       sql`, `,
     )}))`;
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

/**
 * Removed at the source is a state, not a deletion.
 *
 * Older rows predate the column and default to 1, so "still saved" is the
 * honest reading of a library that has never seen an unsave.
 */
function removedClause(removed: ListOptions["removed"]): SQL {
  if (removed === "exclude") return sql`and i.platform_saved = 1`;
  if (removed === "only") return sql`and i.platform_saved = 0`;
  return sql``;
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
function typePredicate(type: string): SQL | null {
  switch (type) {
    case "video":
      return sql`exists (select 1 from media m where m.item_id = i.id and m.kind = 'video_poster')`;
    case "article":
      return sql`json_array_length(coalesce(json_extract(i.raw, '$.links'), '[]')) > 0`;
    case "comment":
      return sql`json_extract(i.raw, '$.isComment') = 1`;
    case "repo":
      return sql`i.kind = 'repo'`;
    case "thread":
      return sql`json_extract(i.raw, '$.inReplyToStatusId') is not null`;
    case "post":
      return sql`(i.kind = 'post'
                  and not exists (select 1 from media m
                                   where m.item_id = i.id and m.kind = 'video_poster'))`;
    default:
      return null;
  }
}

/**
 * Several types mean "any of them", not "all of them".
 *
 * Anded together they are a contradiction — nothing is both a repo and a
 * comment — and a two-type filter returning an empty grid looks exactly like
 * a broken library.
 */
function typeClause(type: string | string[] | undefined): SQL {
  const parts = toList(type)
    .map(typePredicate)
    .filter((p): p is SQL => p !== null);
  if (parts.length === 0) return sql``;
  return sql`and (${sql.join(parts, sql` or `)})`;
}

export type ListOrder = "saved" | "posted";

export class InvalidListCursorError extends Error {
  constructor(order: ListOrder) {
    super(`invalid ${order} cursor`);
    this.name = "InvalidListCursorError";
  }
}

export interface ListOptions {
  /**
   * Opaque, and shaped by `order`. Saved order carries
   * "savedAt.sourceOrder.id"; posted order carries "postedAt.id". The item id
   * makes both orders total when timestamps or source keys tie.
   */
  cursor?: string;
  /** One value or several. Several means "is any of". */
  source?: string | string[];
  author?: string | string[];
  limit?: number;
  /** "any" | "image" | "video" | "none". Single: these are exclusive. */
  media?: string;
  /** post | video | article | comment | repo | thread */
  contentType?: string | string[];
  tag?: string | string[];
  /** Archived items are excluded unless asked for. */
  archived?: boolean;
  /**
   * What to do with items the platform no longer has saved.
   *
   * "include" is the default because the whole point of a local library is
   * that it outlives the platform's opinion; "exclude" is for people who want
   * the library to mirror what is currently saved, and "only" is how you find
   * what has gone.
   */
  removed?: "include" | "exclude" | "only";
  /** Bookmark order by default; "posted" is chronological by the post's date. */
  order?: ListOrder;
  favorite?: boolean;
}

/**
 * The grid's query. Keyset pagination uses the full saved-order tuple rather
 * than offset, because offset pagination silently drops or repeats items
 * whenever the set changes underneath it — and an importer running while
 * someone scrolls is exactly that.
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
  let cursorAt = Number.NaN;
  let cursorOrder = Number.NaN;
  let cursorId = "";
  if (opts.cursor !== undefined) {
    const parts = opts.cursor.split(".");
    if (posted) {
      cursorAt = Number(parts.shift());
      cursorId = parts.join(".");
      if (!Number.isFinite(cursorAt) || !cursorId) throw new InvalidListCursorError("posted");
    } else {
      cursorAt = Number(parts.shift());
      cursorOrder = Number(parts.shift());
      cursorId = parts.join(".");
      if (!Number.isFinite(cursorAt) || !Number.isFinite(cursorOrder) || !cursorId) {
        throw new InvalidListCursorError("saved");
      }
    }
  }
  const hasCursor = opts.cursor !== undefined;

  const keyset = posted
    ? hasCursor
      ? sql`and (coalesce(i.posted_at, 0) < ${cursorAt}
                 or (coalesce(i.posted_at, 0) = ${cursorAt} and i.id > ${cursorId}))`
      : sql``
    : hasCursor
      ? sql`and (i.saved_at < ${cursorAt}
                 or (i.saved_at = ${cursorAt} and coalesce(i.save_order, 0) < ${cursorOrder})
                 or (i.saved_at = ${cursorAt} and coalesce(i.save_order, 0) = ${cursorOrder}
                     and i.id > ${cursorId}))`
      : sql``;

  const ordering = posted
    ? sql`order by coalesce(i.posted_at, 0) desc, i.id asc`
    : sql`order by i.saved_at desc, coalesce(i.save_order, 0) desc, i.id asc`;

  const rows = await db.all<ListPageRow>(sql`
    select i.id, i.url, i.author_handle as author, i.author_name as authorName,
           i.author_avatar as authorAvatar,
           json_extract(i.raw, '$.language') as language,
           json_extract(i.raw, '$.visibility') as visibility,
           i.title, i.posted_at as postedAt, i.saved_at as savedAt,
           i.saved_at_exact as savedAtExact, i.source, i.save_order as saveOrder,
           i.favorite,
           i.platform_saved as platformSaved,
           i.removed_from_source_at as removedFromSourceAt,
           substr(coalesce(json_extract(i.raw, '$.ownText'), i.body, ''), 1, 300) as excerpt,
           0 as score,
           -- Every stored image, not one representative. A card that shows
           -- one of four is a card that misrepresents the post. Stored keys
           -- only, so the grid never hot-links the platform.
           (select json_group_array(json_object('key', m.stored_key, 'kind', m.kind, 'url', m.origin_url))
              from media m where m.item_id = i.id and m.stored_key is not null) as mediaJson,
           (select count(*) from media m where m.item_id = i.id) as mediaCount,
           (select json_group_array(json_object('label',t.label,'color',t.color)) from item_tags it join tags t on t.id=it.tag_id where it.item_id=i.id) as tagsJson,
           case when length(coalesce(i.note, '')) > 0 then 1 else 0 end as hasNote,
           json_extract(i.raw, '$.quoted') as quotedJson,
           i.metrics as metricsJson
    from items i
    where 1 = 1
      and ${visibleSourceClause(sql`i.source`)}
      ${anyOf(sql`i.source`, opts.source)}
      ${anyOf(sql`i.author_handle`, opts.author)}
      ${keyset}
      ${tagClause(opts.tag)}
      ${archiveClause(opts.archived)}
      ${removedClause(opts.removed)}
      ${mediaClause(opts.media)}
      ${typeClause(opts.contentType)}
      ${opts.favorite === undefined ? sql`` : sql`and i.favorite = ${opts.favorite ? 1 : 0}`}
    ${ordering}
    limit ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((rawRow) => {
    const parse = <T,>(text: string | undefined, fallback: T): T => {
      try {
        return (JSON.parse(text ?? "") as T) ?? fallback;
      } catch {
        // Decoration, all of it. A malformed blob costs the extras, not the row.
        return fallback;
      }
    };

    const all = parse<{ key: string; kind: string; url: string }[]>(rawRow.mediaJson, []);
    const quoted = parse<{
      handle: string | null; name: string | null; avatar: string | null;
      text: string; url: string | null; mediaUrls: string[];
    } | null>(rawRow.quotedJson, null);

    // A quote's images live on the parent row; split them back apart so the
    // card can nest them where they belong.
    const quotedUrls = new Set(quoted?.mediaUrls ?? []);
    return {
      id: rawRow.id,
      url: rawRow.url,
      author: rawRow.author,
      authorName: rawRow.authorName,
      authorAvatar: rawRow.authorAvatar,
      language: rawRow.language,
      visibility: rawRow.visibility,
      title: rawRow.title,
      postedAt: rawRow.postedAt,
      savedAt: rawRow.savedAt,
      savedAtExact: rawRow.savedAtExact,
      source: rawRow.source,
      saveOrder: rawRow.saveOrder,
      platformSaved: rawRow.platformSaved,
      removedFromSourceAt: rawRow.removedFromSourceAt,
      favorite: rawRow.favorite === 1,
      mediaCount: rawRow.mediaCount,
      excerpt: rawRow.excerpt,
      score: rawRow.score,
      hasNote: rawRow.hasNote === 1,
      tags: parseTagSummary(rawRow.tagsJson),
      metrics: parse<Record<string, number>>(rawRow.metricsJson, {}),
      media: all.filter((m) => !quotedUrls.has(m.url)),
      quoted: quoted ? { ...quoted, media: all.filter((m) => quotedUrls.has(m.url)) } : null,
    };
  });
  const last = page.at(-1);
  const nextCursor = !hasMore || !last
    ? null
    : posted
      ? `${last.postedAt ?? 0}.${last.id}`
      : `${last.savedAt}.${last.saveOrder ?? 0}.${last.id}`;

  return { items: page, nextCursor };
}

function parseTagSummary(text: string | undefined): TagSummary[] {
	try {
		const value = JSON.parse(text ?? "[]") as unknown;
		if (!Array.isArray(value)) return [];
		return value.filter((tag): tag is TagSummary =>
			tag !== null && typeof tag === "object" && typeof (tag as { label?: unknown }).label === "string" && typeof (tag as { color?: unknown }).color === "string",
		);
	} catch {
		return [];
	}
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
  const [totals] = await db.all<{
    items: number; authors: number; archived: number; today: number;
  }>(sql`
    select sum(case when archived_at is null then 1 else 0 end) as items,
           count(distinct case when archived_at is null then author_handle end) as authors,
           sum(case when archived_at is null then 0 else 1 end) as archived,
           -- First captured today, excluding imports and legacy rows whose
           -- arrival path predates explicit provenance.
           sum(case when capture_origin not in ('platform_import', 'legacy_unknown')
                      and saved_at >= ${Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)}
                    then 1 else 0 end) as today
    from items
    where ${visibleSourceClause(sql`source`)}
  `);
  const bySource = await db.all<{ source: string; n: number }>(sql`
    select source, count(*) as n from items where archived_at is null and ${visibleSourceClause(sql`source`)} group by source
  `);
  const media = await db.all<{ total: number; stored: number }>(sql`
    select count(*) as total,
           sum(case when stored_key is null then 0 else 1 end) as stored
    from media m join items i on i.id = m.item_id
    where ${visibleSourceClause(sql`i.source`)}
  `);
  return {
    items: totals?.items ?? 0,
    authors: totals?.authors ?? 0,
    archived: totals?.archived ?? 0,
    today: totals?.today ?? 0,
    bySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])) as Record<string, number>,
    media: media[0] ?? { total: 0, stored: 0 },
  };
}

/**
 * Per-source health.
 *
 * Timestamp precision and capture provenance are deliberately independent.
 * An API import can carry an exact historical timestamp, while a live event
 * can enrich an item with an inexact provider date. `capture_origin` records
 * the first arrival path and is therefore the only honest source for these
 * counters.
 */
export interface SourceHealth {
  source: string;
  items: number;
  live: number;
  imported: number;
  toolbar: number;
  contextMenu: number;
  chromeBookmarks: number;
  legacyUnknown: number;
  authors: number;
  lastCaptureAt: number | null;
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
      sum(case when i.capture_origin = 'platform_event' then 1 else 0 end) as live,
      sum(case when i.capture_origin = 'platform_import' then 1 else 0 end) as imported,
      sum(case when i.capture_origin = 'toolbar' then 1 else 0 end) as toolbar,
      sum(case when i.capture_origin = 'context_menu' then 1 else 0 end) as contextMenu,
      sum(case when i.capture_origin = 'chrome_bookmark' then 1 else 0 end) as chromeBookmarks,
      sum(case when i.capture_origin = 'legacy_unknown' then 1 else 0 end) as legacyUnknown,
      count(distinct i.author_handle)                              as authors,
      (select max(ce.received_at) from capture_events ce
        where ce.source = i.source
          and ce.action in ('save', 'snapshot')
          and ce.outcome in ('created', 'updated', 'duplicate'))   as lastCaptureAt,
      max(i.saved_at)                                              as lastSavedAt,
      max(i.posted_at)                                             as lastPostedAt,
      (select count(*) from media m
         join items mi on mi.id = m.item_id where mi.source = i.source) as media,
      (select count(*) from media m
         join items mi on mi.id = m.item_id
        where mi.source = i.source and m.stored_key is not null)   as mediaStored
    from items i
    where ${visibleSourceClause(sql`i.source`)}
    group by i.source
    order by items desc
  `);
}
