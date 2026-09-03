import {
  countItems,
  creators,
  findByAuthor,
  getItem,
  disabledSources,
  libraryStats,
  listItems,
  listTags,
  setArchived,
  setSourceEnabled,
  tagItems,
  sourceHealth,
  recentSaves,
  searchItems,
  upsertItems,
} from "@anansi/db";
import type { AnansiDb } from "@anansi/db";
import { readMedia, type MediaSource } from "./media.ts";
import {
  parseBookmarksPage,
  parseItemList,
  parseSavedListing,
  parseStarredPage,
} from "@anansi/sources";

/**
 * The HTTP surface, as plain Request -> Response.
 *
 * Deliberately framework-agnostic: the TanStack route files are three-line
 * wrappers over these, so the routing library's API can churn without
 * touching anything that matters, and these are testable with a bare
 * `new Request(...)`.
 *
 * Every one of them calls the same function the MCP tool calls. That is the
 * spec's rule, and it holds because both import from @anansi/db rather than
 * from each other.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * Number(null) is 0, not NaN — which silently turned an absent ?cursor into
 * cursor=0 and made /api/items return an empty page forever. Absent has to be
 * checked before parsing, not after.
 */
const num = (value: string | null, fallback?: number) => {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export interface ApiEnv {
  db: AnansiDb;
  media?: MediaSource;
  /** Shared secret for /api/ingest. Absent means ingest is closed. */
  ingestToken?: string;
}

export async function handleApi(env: ApiEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;

  // Served from our own copy, never hot-linked: a deleted post still renders,
  // and no request from the library tells the platform what you are reading.
  const mediaMatch = path.match(/^\/api\/media\/(.+)$/);
  if (request.method === "GET" && mediaMatch) {
    return readMedia(env.media ?? {}, decodeURIComponent(mediaMatch[1]!));
  }

  if (request.method === "GET" && path === "/api/items") {
    return json(
      await listItems(env.db, {
        cursor: num(q.get("cursor")),
        source: q.get("source") ?? undefined,
        author: q.get("author") ?? undefined,
        media: q.get("media") ?? undefined,
        contentType: q.get("type") ?? undefined,
        tag: q.get("tag") ?? undefined,
        archived: q.get("archived") === "1",
        limit: num(q.get("limit"), 50),
      }),
    );
  }

  const itemMatch = path.match(/^\/api\/items\/([\w-]+)$/);
  if (request.method === "GET" && itemMatch) {
    const item = await getItem(env.db, itemMatch[1]!);
    return item ? json(item) : json({ error: "not found" }, 404);
  }

  if (request.method === "GET" && path === "/api/search") {
    const query = q.get("q") ?? "";
    if (!query.trim()) return json({ error: "q is required" }, 400);
    return json({
      query,
      results: await searchItems(env.db, {
        query,
        source: q.get("source") ?? undefined,
        author: q.get("author") ?? undefined,
        limit: num(q.get("limit"), 20),
      }),
    });
  }

  if (request.method === "GET" && path === "/api/recent") {
    return json({ results: await recentSaves(env.db, q.get("source") ?? undefined, num(q.get("limit"), 20)) });
  }

  if (request.method === "GET" && path === "/api/authors") {
    const handle = q.get("handle");
    if (!handle) return json({ error: "handle is required" }, 400);
    return json({ results: await findByAuthor(env.db, handle, num(q.get("limit"), 20)) });
  }

  if (request.method === "GET" && path === "/api/tags") {
    return json({ tags: await listTags(env.db) });
  }

  /**
   * Bulk actions, set-shaped on purpose: selecting forty cards and issuing
   * forty round trips is how a bulk action becomes slow enough to abandon.
   */
  if (request.method === "POST" && path === "/api/items/archive") {
    const body = (await request.json().catch(() => ({}))) as { ids?: string[]; archived?: boolean };
    if (!Array.isArray(body.ids)) return json({ error: "expected { ids: [...] }" }, 400);
    return json({ changed: await setArchived(env.db, body.ids, body.archived !== false) });
  }

  if (request.method === "POST" && path === "/api/items/tag") {
    const body = (await request.json().catch(() => ({}))) as { ids?: string[]; label?: string };
    if (!Array.isArray(body.ids) || !body.label) {
      return json({ error: "expected { ids: [...], label }" }, 400);
    }
    return json({ tagged: await tagItems(env.db, body.ids, body.label) });
  }

  if (request.method === "GET" && path === "/api/sources") {
    const [health, off] = await Promise.all([sourceHealth(env.db), disabledSources(env.db)]);
    return json({
      sources: health.map((s) => ({ ...s, enabled: !off.includes(s.source) })),
      disabled: off,
    });
  }

  const toggleMatch = path.match(/^\/api\/sources\/([\w-]+)$/);
  if (request.method === "POST" && toggleMatch) {
    const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
    await setSourceEnabled(env.db, toggleMatch[1]!, body.enabled !== false);
    return json({ source: toggleMatch[1], enabled: body.enabled !== false });
  }

  if (request.method === "GET" && path === "/api/creators") {
    return json({ creators: await creators(env.db, num(q.get("limit"), 100)) });
  }

  if (request.method === "GET" && path === "/api/stats") {
    return json(await libraryStats(env.db));
  }

  /**
   * The extension's instruction sheet.
   *
   * This is what makes shipping load-unpacked viable. The extension knows
   * almost nothing: it fetches this, does what it says, and uploads the raw
   * result. When X moves an endpoint you change this and the parser, and
   * every install is fixed on its next run regardless of when it was
   * installed. The extension's version stops mattering.
   *
   * It doubles as a kill switch: set enabled false and every install stops.
   */
  if (request.method === "GET" && path === "/api/extension/config") {
    // A switched-off source is simply absent from the config, so the
    // extension stops capturing it on its next run without an update.
    const off = new Set(await disabledSources(env.db));
    const all = [
        {
          // Paged: the extension can walk the whole history itself.
          mode: "page",
          source: "x",
          host: "x.com",
          operation: "Bookmarks",
          variables: { count: 100, includePromotedContent: false },
          cursorPrefix: "cursor-bottom",
          entryPrefix: "tweet-",
          pageLimit: 40,
          // Watched for real-time capture; unlike the timeline query this
          // operation IS in the main bundle.
          watchOperations: ["CreateBookmark", "DeleteBookmark"],
        },
        {
          // Also paged, but plain REST rather than GraphQL — no queryId to
          // resolve, and a documented cursor. `me` resolves from the session.
          mode: "page",
          source: "reddit",
          host: "reddit.com",
          url: "https://www.reddit.com/user/me/saved.json?limit=100&raw_json=1",
          cursorParam: "after",
          cursorPath: "data.after",
          pageLimit: 40,
          watchUrls: ["/api/save", "/api/unsave"],
        },
        {
          /**
           * Observe-only, and the reason that mode exists.
           *
           * TikTok publishes no saved/favorites API, and its web requests are
           * signed (X-Bogus, msToken) so they cannot be forged from outside
           * the app. What can be done is watch what the app fetches while you
           * scroll your own Favorites — no forging, no signature work, and the
           * payload is the same one the page renders from.
           *
           * The cost is honest and worth stating in the UI: there is no
           * "import everything" for TikTok. Your history arrives as you scroll
           * it once, and everything after that is captured live.
           */
          mode: "observe",
          source: "tiktok",
          host: "tiktok.com",
          watchUrls: [
            "/api/user/collect/item_list",
            "/api/favorite/item_list",
            "/api/user/favorite/item_list",
          ],
        },
    ];
    return json({
      version: 1,
      enabled: true,
      ingest: new URL("/api/ingest", url.origin).toString(),
      sources: all.filter((s) => !off.has(s.source)),
    });
  }

  /**
   * The extension's endpoint. Bearer auth rather than open, because an open
   * ingest on a public URL is an invitation to have someone else's library
   * merged into yours.
   */
  if (request.method === "POST" && path === "/api/ingest") {
    if (!env.ingestToken) return json({ error: "ingest is not configured" }, 503);
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.ingestToken}`) return json({ error: "unauthorized" }, 401);

    let body: { items?: unknown[]; source?: string; raw?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    /**
     * Two shapes, and the raw one is the point.
     *
     * The extension uploads the untouched platform payload and this parses
     * it. That is what makes shipping load-unpacked viable: when X reshapes a
     * response you fix it here, once, and every install is repaired on its
     * next run — whether it was installed yesterday or six months ago. The
     * extension's version stops mattering.
     *
     * `{ items }` stays for callers that already hold normalized items, which
     * is how the CLI and the tests speak.
     */
    let items: unknown[];
    if (body.raw !== undefined) {
      const importedAt = Math.floor(Date.now() / 1000);
      const parsers: Record<string, (raw: unknown) => unknown[]> = {
        x: (r) => parseBookmarksPage(r, { importedAt }).items,
        github: (r) => parseStarredPage(r, { importedAt }),
        reddit: (r) => parseSavedListing(r, { importedAt }),
        tiktok: (r) => parseItemList(r, { importedAt }),
      };
      const parse = parsers[body.source ?? "x"];
      if (!parse) return json({ error: `unknown source: ${body.source}` }, 400);
      items = parse(body.raw);
      // A payload that parses to nothing is the failure the whole project
      // exists to notice, so say so rather than reporting a cheerful zero.
      if (items.length === 0) {
        return json({ error: "payload parsed to zero items", parsed: 0 }, 422);
      }
    } else if (Array.isArray(body.items)) {
      items = body.items;
    } else {
      return json({ error: "expected { source, raw } or { items: [...] }" }, 400);
    }

    // Idempotent on (source, external_id), so a retried POST is free.
    const result = await upsertItems(env.db, items as never[]);
    return json({ ...result, parsed: items.length });
  }

  return json({ error: "not found" }, 404);
}
