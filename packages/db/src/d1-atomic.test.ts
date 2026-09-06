import { describe, expect, test } from "bun:test";
import type { ItemEventCapture, NormalizedItem } from "@anansi/sources";
import { eq } from "drizzle-orm";
import { applyCapture } from "./capture-events.ts";
import { atomicWrite } from "./atomic.ts";
import { D1_ATOMIC_STATEMENT_LIMIT, openD1 } from "./d1.ts";
import { exportLibrary, restoreLibrary } from "./organization.ts";
import { upsertItems } from "./queries.ts";
import { items, media } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

class FakeStatement {
  constructor(
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new FakeStatement(this.sql, params);
  }

  async all() {
    return { success: true, results: [], meta: {} };
  }

  async raw() {
    return [];
  }

  async run() {
    throw new Error("D1 writes must use batch");
  }
}

class FakeD1 {
  readonly batches: FakeStatement[][] = [];

  prepare(sql: string) {
    return new FakeStatement(sql);
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true, results: [], meta: {} }));
  }
}

const item: NormalizedItem = {
  source: "x",
  externalId: "tweet-d1",
  url: "https://x.com/anansi/status/tweet-d1",
  kind: "post",
  body: "Atomic on D1",
  savedAt: 1_788_390_000,
  savedAtIsExact: true,
  metrics: {},
  media: [],
  links: [],
  raw: {},
};

const capture: ItemEventCapture = {
  schemaVersion: 1,
  payloadType: "item_event",
  eventId: "event-d1-save",
  source: "x",
  action: "save",
  externalId: item.externalId,
  canonicalUrl: item.url,
  observedAt: item.savedAt,
  captureMethod: "platform_event",
  normalizedItem: item,
};

describe("D1 atomic capture", () => {
  test("submits item state and its idempotency receipt in one D1 batch", async () => {
    const binding = new FakeD1();
    const db = openD1(binding as unknown as D1Database);

    const result = await applyCapture(db, capture);

    expect(result).toMatchObject({ eventId: capture.eventId, outcome: "created" });
    expect(binding.batches).toHaveLength(1);
    const sql = binding.batches[0]!.map((statement) => statement.sql.toLowerCase());
    expect(sql.some((statement) => /insert into [`\"]items[`\"]/.test(statement))).toBe(true);
    expect(sql.some((statement) => /insert into [`\"]capture_events[`\"]/.test(statement))).toBe(true);
    expect(sql.some((statement) => /\b(begin|commit|rollback)\b/.test(statement))).toBe(false);
  });

  test("a small logical restore is submitted as one D1 batch", async () => {
    const source = openTestDb();
    await upsertItems(source, [item]);
    const backup = await exportLibrary(source);
    const binding = new FakeD1();
    const db = openD1(binding as unknown as D1Database);

    await restoreLibrary(db, backup);

    expect(binding.batches).toHaveLength(1);
    expect(binding.batches[0]!.some((statement) =>
      /insert into [`\"]items[`\"]/.test(statement.sql.toLowerCase()),
    )).toBe(true);
  });

  test("rejects an oversized atomic group before D1 executes a partial batch", async () => {
    const binding = new FakeD1();
    const db = openD1(binding as unknown as D1Database);

    await expect(atomicWrite(db, (target) =>
      Array.from({ length: D1_ATOMIC_STATEMENT_LIMIT + 1 }, (_, index) =>
        target.insert(items).values({
          ...item,
          id: `id-${index}`,
          raw: "{}",
          metrics: "{}",
        }),
      ),
    )).rejects.toThrow("personal-tier limit");
    expect(binding.batches).toHaveLength(0);
  });
});

describe("atomic-write adapters", () => {
  test("SQLite rolls back every statement when one write fails", async () => {
    const db = openTestDb();

    await expect(atomicWrite(db, (target) => [
      target.insert(items).values({
        id: "rollback-item",
        source: "web",
        externalId: "rollback",
        url: "https://example.com/rollback",
        kind: "article",
        body: "should not survive",
        savedAt: 1,
        metrics: "{}",
        raw: "{}",
      }),
      target.insert(media).values({
        id: "invalid-media",
        itemId: "missing-item",
        kind: "image",
        originUrl: "https://images.example.com/missing.png",
      }),
    ])).rejects.toThrow("FOREIGN KEY");

    expect(await db.select().from(items).where(eq(items.id, "rollback-item"))).toHaveLength(0);
  });
});
