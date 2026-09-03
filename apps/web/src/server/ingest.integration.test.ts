import { describe, expect, test } from "bun:test";
import { type AnansiDb, captureEvents, items } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { ItemEventCapture, NormalizedItem, RawPageCapture } from "@anansi/sources";
import { ingestCapture } from "./ingest.ts";

/**
 * Sequences, against one live library.
 *
 * The unit tests check what a single request does. These check what a series
 * of them does when the series arrives in the wrong order, twice, or with a
 * gap in the middle — which is the only order a queue on a service worker that
 * keeps being killed can actually promise.
 */
const now = 1_788_390_000;

const openTestDb = () => {
  const db = openLocalDb(":memory:");
  migrateLocalDb(db);
  return db as unknown as AnansiDb;
};

const post = (id: string, overrides: Partial<NormalizedItem> = {}): NormalizedItem => ({
  source: "x",
  externalId: id,
  url: `https://x.com/anansi/status/${id}`,
  kind: "post",
  body: `post ${id}`,
  savedAt: now,
  savedAtIsExact: true,
  metrics: {},
  media: [],
  links: [],
  raw: {},
  ...overrides,
});

const event = (overrides: Partial<ItemEventCapture> = {}): ItemEventCapture => ({
  schemaVersion: 1,
  payloadType: "item_event",
  eventId: "e-1",
  source: "x",
  action: "save",
  externalId: "tweet-1",
  canonicalUrl: "https://x.com/anansi/status/tweet-1",
  observedAt: now,
  captureMethod: "platform_event",
  normalizedItem: post("tweet-1"),
  ...overrides,
});

const redditPage = (eventId: string, page: number, ids: string[]): RawPageCapture => ({
  schemaVersion: 1,
  payloadType: "raw_page",
  eventId,
  source: "reddit",
  action: "snapshot",
  observedAt: now,
  captureMethod: "platform_import",
  runId: "run-1",
  page,
  raw: {
    kind: "Listing",
    data: {
      after: null,
      children: ids.map((id) => ({
        kind: "t3",
        data: {
          id,
          name: `t3_${id}`,
          title: `saved ${id}`,
          selftext: "",
          permalink: `/r/selfhosted/comments/${id}/saved/`,
          subreddit: "selfhosted",
          author: "anansi",
          created_utc: now - 100,
          score: 1,
          num_comments: 0,
        },
      })),
    },
  },
});

const send = (db: AnansiDb, capture: ItemEventCapture | RawPageCapture) =>
  ingestCapture(
    db,
    new Request("https://anansi.test/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": capture.eventId,
      },
      body: JSON.stringify(capture),
    }),
  );

const rows = (db: AnansiDb) => db.select().from(items);

/* ------------------------------------------------------ a whole run ---- */

describe("an import run", () => {
  test("three pages become three items, and a replayed page adds none", async () => {
    const db = openTestDb();

    await send(db, redditPage("run-1:page:1", 1, ["a1"]));
    await send(db, redditPage("run-1:page:2", 2, ["b1"]));
    await send(db, redditPage("run-1:page:3", 3, ["c1"]));
    expect(await rows(db)).toHaveLength(3);

    // The worker died before deleting the record, so page 2 goes again.
    const replay = await send(db, redditPage("run-1:page:2", 2, ["b1"]));

    expect(replay.status).toBe(200);
    expect(await rows(db)).toHaveLength(3);
    expect(await db.select().from(captureEvents)).toHaveLength(3);
  });

  test("a run resumed after a restart still ends with every item once", async () => {
    const db = openTestDb();

    await send(db, redditPage("run-1:page:1", 1, ["a1", "a2"]));
    await send(db, redditPage("run-1:page:2", 2, ["b1"]));

    // Restart: the cursor was persisted after page 2, so the run resumes at
    // page 3 — and the extension re-sends page 2, which it had not yet
    // deleted locally.
    await send(db, redditPage("run-1:page:2", 2, ["b1"]));
    await send(db, redditPage("run-1:page:3", 3, ["c1"]));

    expect(await rows(db)).toHaveLength(4);
  });

  test("a page that parses to nothing is not acknowledged, so it can be retried", async () => {
    const db = openTestDb();

    const first = await send(db, redditPage("run-1:page:1", 1, []));
    expect(first.status).toBe(422);
    expect(await db.select().from(captureEvents)).toHaveLength(0);

    // The parser is fixed server-side and the same event is delivered again.
    const second = await send(db, redditPage("run-1:page:1", 1, ["a1"]));
    expect(second.status).toBe(200);
    expect(await rows(db)).toHaveLength(1);
  });
});

/* --------------------------------------------- out of order events ----- */

describe("events arriving out of order", () => {
  test("an unsave keeps the item and records that it is gone from the source", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    await send(db, event({ eventId: "unsave-1", action: "unsave", observedAt: now + 60 }));

    const [item] = await rows(db);
    expect(item).toBeDefined();
    expect(item?.platformSaved).toBe(0);
    expect(item?.removedFromSourceAt).toBe(now + 60);
    // Never a delete: the library keeps what you saved even after the
    // platform stops agreeing that you did.
    expect(await rows(db)).toHaveLength(1);
  });

  test("an older save delivered after a newer unsave does not resurrect it", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    await send(db, event({ eventId: "unsave-1", action: "unsave", observedAt: now + 60 }));

    // This one was queued before the unsave and only got out afterwards.
    const late = await send(db, event({ eventId: "save-late", observedAt: now + 10 }));

    expect(late.body).toMatchObject({ outcome: "ignored_stale" });
    const [item] = await rows(db);
    expect(item?.platformSaved).toBe(0);
  });

  test("saving again with a newer event clears the removal", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    await send(db, event({ eventId: "unsave-1", action: "unsave", observedAt: now + 60 }));
    await send(db, event({ eventId: "save-2", observedAt: now + 120 }));

    const [item] = await rows(db);
    expect(item?.platformSaved).toBe(1);
    expect(item?.removedFromSourceAt).toBeNull();
  });

  test("the stale event is still recorded, so it is never delivered forever", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    await send(db, event({ eventId: "unsave-1", action: "unsave", observedAt: now + 60 }));
    await send(db, event({ eventId: "save-late", observedAt: now + 10 }));

    const recorded = await db.select().from(captureEvents);
    expect(recorded.map((e) => e.eventId).sort()).toEqual([
      "save-1",
      "save-late",
      "unsave-1",
    ]);
  });
});

/* ----------------------------------------------- ambiguous delivery ---- */

describe("delivered twice after an ambiguous failure", () => {
  test("the replay returns the same receipt and leaves one item", async () => {
    const db = openTestDb();

    const first = await send(db, event({ eventId: "save-1" }));
    const replay = await send(db, event({ eventId: "save-1" }));

    expect(replay.body).toEqual(first.body);
    expect(await rows(db)).toHaveLength(1);
    expect(await db.select().from(captureEvents)).toHaveLength(1);
  });

  test("two different events about the same post are still one item", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    await send(db, event({ eventId: "save-2", observedAt: now + 30 }));

    expect(await rows(db)).toHaveLength(1);
    expect(await db.select().from(captureEvents)).toHaveLength(2);
  });
});

/* ------------------------------------------------- nothing invented ---- */

describe("an event with no content", () => {
  test("a save for an item the library has never seen creates no phantom", async () => {
    const db = openTestDb();

    const result = await send(db, event({ eventId: "save-1", normalizedItem: undefined }));

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await rows(db)).toHaveLength(0);
  });

  test("a save with no content is fine once the item exists", async () => {
    const db = openTestDb();

    await send(db, event({ eventId: "save-1", observedAt: now }));
    const bare = await send(
      db,
      event({ eventId: "save-2", observedAt: now + 30, normalizedItem: undefined }),
    );

    expect(bare.status).toBe(200);
    expect(await rows(db)).toHaveLength(1);
  });

  test("an unsave for an unknown item is ignored rather than an error", async () => {
    const db = openTestDb();

    const result = await send(
      db,
      event({ eventId: "unsave-1", action: "unsave", normalizedItem: undefined }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "ignored_stale" });
    expect(await rows(db)).toHaveLength(0);
  });
});
