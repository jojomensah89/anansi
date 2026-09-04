import { describe, expect, test } from "bun:test";
import { applyCapture } from "./capture-events.ts";
import { upsertItems } from "./queries.ts";
import { listItems } from "./search.ts";
import { openTestDb } from "./test-db.ts";

/**
 * Removed at the source, kept in the library.
 *
 * An unsave never deletes anything — that is the point of keeping your own
 * copy — so the difference has to survive as state the library can read back,
 * and be filterable in all three directions.
 */
const item = (externalId: string) => ({
  source: "x" as const,
  externalId,
  url: `https://x.com/anansi/status/${externalId}`,
  kind: "post",
  body: `post ${externalId}`,
  authorHandle: "anansi",
  postedAt: 1_000,
  savedAt: 1_000,
  savedAtIsExact: true,
  metrics: {},
  media: [],
  links: [],
  raw: {},
});

const unsave = (externalId: string, observedAt = 2_000) => ({
  schemaVersion: 1 as const,
  payloadType: "item_event" as const,
  eventId: `unsave-${externalId}`,
  source: "x" as const,
  action: "unsave" as const,
  externalId,
  canonicalUrl: `https://x.com/anansi/status/${externalId}`,
  observedAt,
  captureMethod: "platform_event" as const,
});

async function library() {
  const db = openTestDb();
  await upsertItems(db, [item("kept"), item("gone")]);
  await applyCapture(db, unsave("gone"));
  return db;
}

describe("items removed at the source", () => {
  test("the row survives the unsave", async () => {
    const db = await library();

    expect((await listItems(db, { limit: 50 })).items.length).toBe(2);
  });

  test("the state comes back with the item, so a card can show it", async () => {
    const db = await library();

    const rows = (await listItems(db, { limit: 50 })).items;
    const gone = rows.find((r) => r.url.endsWith("gone"));
    const kept = rows.find((r) => r.url.endsWith("kept"));

    expect(gone?.platformSaved).toBe(0);
    expect(gone?.removedFromSourceAt).toBe(2_000);
    expect(kept?.platformSaved).toBe(1);
    expect(kept?.removedFromSourceAt).toBeNull();
  });

  test("include is the default, because the library outlives the platform", async () => {
    const db = await library();

    expect((await listItems(db, { limit: 50 })).items.length).toBe(2);
    expect((await listItems(db, { limit: 50, removed: "include" })).items.length).toBe(2);
  });

  test("exclude mirrors what is currently saved", async () => {
    const db = await library();

    const rows = (await listItems(db, { limit: 50, removed: "exclude" })).items;
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toEndWith("kept");
  });

  test("only is how you find what has gone", async () => {
    const db = await library();

    const rows = (await listItems(db, { limit: 50, removed: "only" })).items;
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toEndWith("gone");
  });

  test("a library that has never seen an unsave reads as all saved", async () => {
    const db = openTestDb();
    await upsertItems(db, [item("a"), item("b")]);

    // Rows written before the column existed default to 1, so excluding
    // removed items must not empty an untouched library.
    expect((await listItems(db, { limit: 50, removed: "exclude" })).items.length).toBe(2);
  });

  test("saving again puts it back", async () => {
    const db = await library();
    await applyCapture(db, {
      ...unsave("gone", 3_000),
      eventId: "resave-gone",
      action: "save",
    });

    const rows = (await listItems(db, { limit: 50, removed: "exclude" })).items;
    expect(rows.length).toBe(2);
  });
});
