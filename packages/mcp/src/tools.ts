import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findByAuthor, getItem, recentSaves, searchItems } from "@anansi/db";
import type { AnansiDb, ItemDetail, SearchHit } from "@anansi/db";
import { MCP_TOOL_CATALOG } from "./catalog.ts";

/**
 * Four tools, reading the same database through the same functions the HTTP
 * routes will call. Keep the surface small: an agent with four sharp tools
 * outperforms one with twelve fuzzy ones.
 *
 * Registered against a server rather than hard-wired to a transport, because
 * the same four run over stdio locally and over HTTP from a Worker later.
 * That is the spec's rule made structural — there is no second
 * implementation to drift.
 */

/** Excerpts, never full bodies: ten full posts would blow a context window. */
const EXCERPT_LIMIT = 300;
const MCP_SOURCES = z.enum(["x", "reddit", "github", "web"]);

function trim(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= EXCERPT_LIMIT ? clean : clean.slice(0, EXCERPT_LIMIT - 1) + "…";
}

function iso(unix: number | null): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

/**
 * Always return `url`. An unattributed memory is a hallucination waiting to
 * happen, and the agent needs somewhere to send the reader.
 */
function hit(row: SearchHit) {
  return {
    id: row.id,
    url: row.url,
    author: row.author,
    title: row.title,
    excerpt: trim(row.excerpt),
    source: row.source,
    posted_at: iso(row.postedAt),
    saved_at: iso(row.savedAt),
    // Surfaced because it is not what it looks like: backfilled items carry
    // import time, not the moment you saved them.
    saved_at_is_exact: row.savedAtExact === 1,
    score: row.score,
  };
}

function detail(item: ItemDetail) {
  return {
    id: item.id,
    url: item.url,
    source: item.source,
    author: item.author,
    author_name: item.authorName,
    title: item.title,
    full_text: item.fullText,
    posted_at: iso(item.postedAt),
    saved_at: iso(item.savedAt),
    saved_at_is_exact: item.savedAtExact,
    metrics: item.metrics,
    media: item.media,
    links: item.links,
    thread: item.thread.map((t) => ({ ...t, excerpt: trim(t.excerpt) })),
  };
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerTools(server: McpServer, db: AnansiDb): void {
  server.registerTool(
    MCP_TOOL_CATALOG[0].name,
    {
      title: "Search saved posts",
      description:
        "Keyword search across every visible saved item from X, Reddit, GitHub, " +
        "and web pages. " +
        "Returns excerpts with a source URL, ranked by BM25 (negative; lower is " +
        "better). Use this first, then get_item to pull one result into context. " +
        "Matching is keyword-based with English stemming and no fuzziness, so a " +
        "misspelling returns nothing rather than a near miss — if a query comes " +
        "back empty, try a likely correction or a broader single term.",
      inputSchema: {
        query: z.string().describe("Words to search for. A trailing * does prefix matching."),
        source: MCP_SOURCES.optional(),
        author: z.string().optional().describe("Restrict to one handle."),
        since: z.string().optional().describe("ISO date; only posts newer than this."),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, source, author, since, limit }) => {
      const sinceUnix = since ? Math.floor(Date.parse(since) / 1000) : undefined;
      const rows = await searchItems(db, {
        query,
        source,
        author,
        since: Number.isFinite(sinceUnix) ? sinceUnix : undefined,
        limit,
      });
      return json({ query, count: rows.length, results: rows.map(hit) });
    },
  );

  server.registerTool(
    MCP_TOOL_CATALOG[1].name,
    {
      title: "Get one saved item",
      description:
        "The full text of one saved item, with its media, outbound links, and any " +
        "other saved posts from the same thread. Call after search_memory.",
      inputSchema: { id: z.string().describe("The id from a search_memory result.") },
    },
    async ({ id }) => {
      const item = await getItem(db, id);
      return item ? json(detail(item)) : json({ error: "no item with id " + id });
    },
  );

  server.registerTool(
    MCP_TOOL_CATALOG[2].name,
    {
      title: "Recently saved",
      description:
        "What the user saved most recently, in true bookmark order. Note that " +
        "saved_at is the import time for backfilled items, not the moment they " +
        "were saved — saved_at_is_exact says which. The ordering is correct " +
        "regardless; the timestamps are not yet.",
      inputSchema: {
        source: MCP_SOURCES.optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ source, limit }) => {
      const rows = await recentSaves(db, source, limit);
      return json({ count: rows.length, results: rows.map(hit) });
    },
  );

  server.registerTool(
    MCP_TOOL_CATALOG[3].name,
    {
      title: "Everything from one author",
      description:
        "Everything the user saved from one handle, newest first. Answers " +
        "'what has pontusab shown me about the AI SDK?'",
      inputSchema: {
        handle: z.string().describe("Handle without the @."),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ handle, limit }) => {
      const rows = await findByAuthor(db, handle.replace(/^@/, ""), limit);
      return json({ handle, count: rows.length, results: rows.map(hit) });
    },
  );
}
