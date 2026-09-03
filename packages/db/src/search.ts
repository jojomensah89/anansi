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

export interface SearchHit {
  id: string;
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
  title: string | null;
  fullText: string;
  postedAt: number | null;
  savedAt: number;
  savedAtExact: boolean;
  metrics: Record<string, number>;
  media: { kind: string; originUrl: string; width: number | null; height: number | null }[];
  links: string[];
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
    title: string | null; body: string | null; postedAt: number | null; savedAt: number;
    savedAtExact: number; metrics: string; raw: string;
  }>(sql`
    select id, url, source, author_handle as author, author_name as authorName,
           title, body, posted_at as postedAt, saved_at as savedAt,
           saved_at_exact as savedAtExact, metrics, raw
    from items where id = ${id} limit 1
  `);

  const row = rows[0];
  if (!row) return null;

  let parsed: { links?: string[]; conversationId?: string } = {};
  try {
    parsed = JSON.parse(row.raw) as typeof parsed;
  } catch {
    // A payload we cannot parse should cost the extras, not the item.
  }

  const mediaRows = await db.all<{
    kind: string; originUrl: string; width: number | null; height: number | null;
  }>(sql`
    select kind, origin_url as originUrl, width, height
    from media where item_id = ${id}
  `);

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
    title: row.title,
    fullText: row.body ?? "",
    postedAt: row.postedAt,
    savedAt: row.savedAt,
    savedAtExact: row.savedAtExact === 1,
    metrics,
    media: mediaRows,
    links: parsed.links ?? [],
    thread,
  };
}
