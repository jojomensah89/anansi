import {
  countItems,
  creators,
  findByAuthor,
  getItem,
  listItems,
  recentSaves,
  searchItems,
  upsertItems,
} from "@anansi/db";
import type { AnansiDb } from "@anansi/db";

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
  /** Shared secret for /api/ingest. Absent means ingest is closed. */
  ingestToken?: string;
}

export async function handleApi(env: ApiEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;

  if (request.method === "GET" && path === "/api/items") {
    return json(
      await listItems(env.db, {
        cursor: num(q.get("cursor")),
        source: q.get("source") ?? undefined,
        author: q.get("author") ?? undefined,
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

  if (request.method === "GET" && path === "/api/creators") {
    return json({ creators: await creators(env.db, num(q.get("limit"), 100)) });
  }

  if (request.method === "GET" && path === "/api/stats") {
    return json({ items: await countItems(env.db) });
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

    let body: { items?: unknown[] };
    try {
      body = (await request.json()) as { items?: unknown[] };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (!Array.isArray(body.items)) return json({ error: "expected { items: [...] }" }, 400);

    // Idempotent on (source, external_id), so a retried POST is free.
    const result = await upsertItems(env.db, body.items as never[]);
    return json(result);
  }

  return json({ error: "not found" }, 404);
}
