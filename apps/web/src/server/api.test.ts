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

  test("versioned ingest requires auth and a matching idempotency key", async () => {
    const capture = {
      schemaVersion: 1,
      payloadType: "item_event",
      eventId: "api-web-save-1",
      source: "web",
      action: "save",
      externalId: "sha256:api-web-save-1",
      canonicalUrl: "https://example.com/durable-bookmarks",
      observedAt: 1_788_390_100,
      captureMethod: "toolbar",
      normalizedItem: {
        source: "web",
        externalId: "sha256:api-web-save-1",
        url: "https://example.com/durable-bookmarks",
        kind: "article",
        body: "Durable bookmarks",
        savedAt: 1_788_390_100,
        savedAtIsExact: true,
        metrics: {},
        media: [],
        links: [],
        raw: {},
      },
    };
    const send = (authorization?: string, idempotencyKey?: string) =>
      handleApi(env, new Request("https://anansi.test/api/ingest", {
        method: "POST",
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(capture),
      }));

    expect((await send()).status).toBe(401);
    expect((await send("Bearer test-token", "wrong-event")).status).toBe(400);

    const first = await send("Bearer test-token", capture.eventId);
    const firstBody = await readJson(first);
    const replay = await send("Bearer test-token", capture.eventId);
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ eventId: capture.eventId, outcome: "created" });
    expect(await readJson(replay)).toEqual(firstBody);
  });

  test("extension config is readable without a token, and names the ingest url", async () => {
    const body = await readJson(get("/api/extension/config"));
    expect(body.version).toBe(1);
    expect(body.enabled).toBe(true);
    expect(body.ingest).toEndWith("/api/ingest");
    expect(body.sources[0].operation).toBe("Bookmarks");
    expect(body.ingestProtocolVersion).toBe(2);
    // Web is on because it has no legacy path to conflict with; the platform
    // sources stay staged until each has passed authenticated acceptance.
    expect(body.features.captureV2).toEqual({
      x: false,
      reddit: false,
      tiktok: false,
      web: true,
    });
    expect(body.features.chromeBookmarks).toBe(false);

    const tiktok = body.sources.find((source: { source: string }) => source.source === "tiktok");
    expect(tiktok.watchUrls).toEqual(["/api/user/collect/item_list"]);
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

describe("repeated filter params", () => {
  beforeAll(async () => {
    await upsertItems(db, [
      {
        source: "reddit",
        externalId: "r-1",
        url: "https://www.reddit.com/r/x/comments/r1/",
        kind: "post",
        authorHandle: "redditor",
        body: "a reddit save",
        postedAt: 1_788_380_000,
        savedAt: 1_788_380_000,
        savedAtIsExact: false,
        metrics: {},
        media: [],
        links: [],
        raw: {},
      },
      {
        source: "github",
        externalId: "g-1",
        url: "https://github.com/anansi/anansi",
        kind: "repo",
        authorHandle: "anansi",
        body: "a starred repo",
        postedAt: 1_788_370_000,
        savedAt: 1_788_370_000,
        savedAtIsExact: true,
        metrics: {},
        media: [],
        links: [],
        raw: {},
      },
    ]);
  });

  test("?source=a&source=b returns both, not neither", async () => {
    const body = await readJson(get("/api/items?source=reddit&source=github&limit=50"));
    const sources = [...new Set(body.items.map((i: any) => i.source))].sort();

    expect(sources).toEqual(["github", "reddit"]);
  });

  test("the first value is not the only one used", async () => {
    // github alone matches one item; if only the first param were read this
    // would return that one item rather than both.
    const body = await readJson(get("/api/items?source=github&source=reddit&limit=50"));

    expect(body.items.length).toBe(2);
  });

  test("one value still behaves exactly as before", async () => {
    const body = await readJson(get("/api/items?source=reddit&limit=50"));

    expect(body.items.length).toBe(1);
    expect(body.items[0].source).toBe("reddit");
  });

  test("no filter param is no filter, not an empty library", async () => {
    const body = await readJson(get("/api/items?limit=50"));

    expect(body.items.length).toBeGreaterThan(12);
  });

  test("content types are ORed across the wire too", async () => {
    const body = await readJson(get("/api/items?type=repo&type=comment&limit=50"));

    expect(body.items.map((i: any) => i.source)).toEqual(["github"]);
  });

  test("a hostile value is bound, not interpolated", async () => {
    const hostile = encodeURIComponent("x') or 1=1 --");
    const res = await get(`/api/items?source=reddit&source=${hostile}&limit=50`);

    expect(res.status).toBe(200);
    expect((await res.json() as any).items.length).toBe(1);
  });
});
