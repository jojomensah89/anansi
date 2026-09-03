import { beforeAll, describe, expect, test } from "bun:test";
import { upsertItems, type AnansiDb } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { handleApi } from "./api.ts";

/**
 * The HTTP surface, tested against a fully migrated in-memory library with no
 * framework in the way. That is the point of handleApi being a plain function: these
 * assertions hold whatever TanStack's route-file API looks like this month,
 * and they will keep holding when the same function runs on D1 in a Worker.
 */
const localDb = openLocalDb(":memory:");
migrateLocalDb(localDb);
const db = localDb as unknown as AnansiDb;
const env = { db, ingestToken: "test-token" };

beforeAll(async () => {
  await upsertItems(
    db,
    Array.from({ length: 12 }, (_, index) => ({
      source: "x",
      externalId: `seed-${index}`,
      url: `https://x.com/anansi/status/seed-${index}`,
      kind: "post",
      authorHandle: index % 2 === 0 ? "anansi" : "arachne",
      authorName: index % 2 === 0 ? "Anansi" : "Arachne",
      body: index === 0 ? "ai sdk artifacts" : `seed item ${index}`,
      postedAt: 1_788_390_000 - index,
      savedAt: 1_788_390_000 - index,
      savedAtIsExact: true,
      saveOrder: 10_000 - index,
      metrics: {},
      media: [],
      links: [],
      raw: {},
    })),
  );
});

const get = (path: string) => handleApi(env, new Request("https://anansi.test" + path));

// Response.json() is typed `unknown` here; these are assertions about a shape
// we control, so read it as any rather than sprinkling casts.
const readJson = async (res: Response | Promise<Response>): Promise<any> =>
  (await (await res).json()) as any;

describe("handleApi", () => {
  test("GET /api/stats reports the library size", async () => {
    const body = await readJson(get("/api/stats"));
    expect(body.items).toBeGreaterThan(0);
  });

  test("GET /api/items paginates by keyset, not offset", async () => {
    const first = await readJson(get("/api/items?limit=5"));
    expect(first.items).toHaveLength(5);
    // Opaque on purpose: its shape depends on the order asked for.
    expect(first.nextCursor).toBeString();

    const second = await readJson(get(`/api/items?limit=5&cursor=${first.nextCursor}`));
    const overlap = second.items.filter((i: { id: string }) =>
      first.items.some((f: { id: string }) => f.id === i.id));
    expect(overlap).toHaveLength(0);
  });

  test("GET /api/items rejects a malformed cursor", async () => {
    const res = await get("/api/items?cursor=not-a-cursor");
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "invalid saved cursor" });
  });

  /**
   * The property that matters for Timeline: paging the whole library in date
   * order reaches every item exactly once. Two posts can share a second, so a
   * cursor that cannot break that tie drops or repeats items at any page
   * boundary that lands on one.
   */
  test("order=posted walks the whole library, in order, without repeats", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let previous = Number.POSITIVE_INFINITY;
    let pages = 0;

    do {
      const q = new URLSearchParams({ order: "posted", limit: "200" });
      if (cursor) q.set("cursor", cursor);
      const page = await readJson(get(`/api/items?${q}`));
      pages++;
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        const at = item.postedAt ?? 0;
        expect(at).toBeLessThanOrEqual(previous);
        previous = at;
      }
      cursor = page.nextCursor;
    } while (cursor && pages < 25);

    const stats = await readJson(get("/api/stats"));
    expect(seen.size).toBe(stats.items);
  });

  test("GET /api/search returns bm25-ranked hits", async () => {
    const body = await readJson(get("/api/search?q=ai+sdk+artifacts&limit=3"));
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].url).toStartWith("https://");
  });

  test("GET /api/search rejects an empty query rather than returning everything", async () => {
    expect((await get("/api/search?q=")).status).toBe(400);
  });

  test("a hostile query returns no results rather than a 500", async () => {
    const res = await get("/api/search?q=" + encodeURIComponent("it's a * mess (AND"));
    expect(res.status).toBe(200);
    expect((await readJson(res)).results).toEqual([]);
  });

  test("GET /api/items/:id returns the full item, never raw", async () => {
    const list = await readJson(get("/api/items?limit=1"));
    const item = await readJson(get(`/api/items/${list.items[0].id}`));
    expect(item.url).toStartWith("https://");
    expect(item).not.toHaveProperty("raw");
  });

  test("GET /api/items/:id 404s for an unknown id", async () => {
    expect((await get("/api/items/does-not-exist")).status).toBe(404);
  });

  test("GET /api/creators is a group-by", async () => {
    const body = await readJson(get("/api/creators?limit=3"));
    expect(body.creators[0].saves).toBeGreaterThanOrEqual(body.creators[1].saves);
  });

  test("POST /api/ingest refuses without the bearer token", async () => {
    const res = await handleApi(env, new Request("https://anansi.test/api/ingest", {
      method: "POST",
      body: JSON.stringify({ items: [] }),
    }));
    expect(res.status).toBe(401);
  });

  test("POST /api/ingest is closed entirely when no token is configured", async () => {
    const res = await handleApi({ db }, new Request("https://anansi.test/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ items: [] }),
    }));
    expect(res.status).toBe(503);
  });

  test("extension config is readable without a token, and names the ingest url", async () => {
    const body = await readJson(get("/api/extension/config"));
    expect(body.enabled).toBe(true);
    expect(body.ingest).toEndWith("/api/ingest");
    expect(body.sources[0].operation).toBe("Bookmarks");
  });

  test("ingest parses a raw payload server-side", async () => {
    const raw = await Bun.file("data/raw/x/page-1788389226894-0001.json").json();
    const res = await handleApi(env, new Request("https://anansi.test/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ source: "x", raw }),
    }));
    expect(res.status).toBe(200);
    expect((await readJson(res)).parsed).toBeGreaterThan(50);
  });

  test("a raw payload that parses to nothing is an error, not a cheerful zero", async () => {
    const res = await handleApi(env, new Request("https://anansi.test/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ source: "x", raw: { data: {} } }),
    }));
    expect(res.status).toBe(422);
  });

  test("unknown routes 404", async () => {
    expect((await get("/api/nope")).status).toBe(404);
  });
});
