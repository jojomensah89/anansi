import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setArchived, setSourceEnabled, tagItems, type IngestItem, upsertItems } from "./queries.ts";
import { items, media, tags } from "./schema.ts";
import { hydrateSearchItems, listItems, searchItemsPage, sourceHealth, toFtsQuery } from "./search.ts";
import { openTestDb } from "./test-db.ts";

/**
 * The spec names three inputs that throw or silently return nothing if bound
 * raw: an apostrophe, a bare `*`, and a non-Latin string. These are those,
 * plus every other way FTS5's grammar bites.
 *
 * The assertion that matters is not the exact query string — it is that
 * `match` never throws, because a thrown query in an MCP tool call looks to
 * an agent like the library is broken.
 */
const fts = new Database(":memory:");
fts.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61')");
fts.exec("INSERT INTO t(body) VALUES ('embedding models and the ai sdk'), ('UIデザインの話')");

const runs = (query: string): number | string => {
  const q = toFtsQuery(query);
  if (!q) return "empty";
  try {
    return (fts.query("select count(*) c from t where t match ?1").get(q) as { c: number }).c;
  } catch (e) {
    return "THREW: " + (e as Error).message;
  }
};

describe("toFtsQuery", () => {
  test("quotes bare terms, implicit AND", () => {
    expect(toFtsQuery("ai sdk")).toBe('"ai" "sdk"');
  });

  test("keeps trailing * as a prefix search", () => {
    expect(toFtsQuery("embed*")).toBe('"embed"*');
    expect(runs("embed*")).toBe(1);
  });

  test("preserves an explicit phrase", () => {
    expect(toFtsQuery('"ai sdk"')).toBe('"ai sdk"');
  });

  test("an empty or whitespace query searches for nothing, not everything", () => {
    expect(toFtsQuery("   ")).toBe("");
    expect(runs("   ")).toBe("empty");
  });

  // Each of these throws if bound raw.
  const hostile = [
    "it's working",
    "*",
    "AND OR NOT",
    'a "b',
    "(broken",
    "NEAR(x y)",
    "^caret",
    "col:umn",
    "-minus",
    "UIデザイン",
    "emoji 🔥 test",
  ];

  for (const input of hostile) {
    test(`never throws on ${JSON.stringify(input)}`, () => {
      expect(String(runs(input))).not.toStartWith("THREW");
    });
  }

  test("a bare * is not a match-everything wildcard", () => {
    expect(runs("*")).toBe("empty");
  });
});

const sourceItem = (externalId: string, savedAtIsExact: boolean): IngestItem => ({
  source: "x",
  externalId,
  url: `https://x.com/i/status/${externalId}`,
  kind: "post",
  body: externalId,
  savedAt: 1_788_390_000,
  savedAtIsExact,
  metrics: {},
  media: [],
  links: [],
  raw: {},
});

describe("sourceHealth", () => {
  test("counts first-arrival provenance independently of timestamp precision", async () => {
    const db = openTestDb();
    await upsertItems(db, [sourceItem("import-exact", true)], {
      captureOrigin: "platform_import",
    });
    await upsertItems(db, [sourceItem("live-inexact", false)], {
      captureOrigin: "platform_event",
    });
    await upsertItems(db, [sourceItem("legacy", true)]);

    const [health] = await sourceHealth(db);
    expect(health).toMatchObject({
      source: "x",
      items: 3,
      live: 1,
      imported: 1,
      toolbar: 0,
      contextMenu: 0,
      chromeBookmarks: 0,
      legacyUnknown: 1,
    });
  });
});

const projectionFixture = (): IngestItem => ({
  source: "x",
  externalId: "projection-rich",
  url: "https://x.com/i/status/projection-rich",
  kind: "post",
  authorHandle: "jojo",
  authorName: "Jojo Mensah",
  authorAvatar: "https://cdn.test/jojo.png",
  title: "Projection fixture",
  body: "common projection fixture body",
  lang: "en",
  postedAt: 1_788_390_123,
  savedAt: 1_788_390_456,
  savedAtIsExact: true,
  saveOrder: 10,
  metrics: { likes: 7 },
  media: [
    { kind: "image", originUrl: "https://cdn.test/main.jpg" },
    { kind: "image", originUrl: "https://cdn.test/quote.jpg" },
    { kind: "video_poster", originUrl: "https://cdn.test/missing.mp4" },
  ],
  links: ["https://example.test/docs"],
  raw: {
    ownText: "shared own text",
    language: "TypeScript",
    visibility: "public",
    quoted: {
      handle: "quoted",
      name: "Quoted Author",
      avatar: null,
      text: "quoted words",
      url: "https://x.com/quoted/status/1",
      mediaUrls: ["https://cdn.test/quote.jpg"],
    },
  },
});

const excludedFixture = (externalId: string, source = "x"): IngestItem => ({
  source,
  externalId,
  url: `https://${source}.test/${externalId}`,
  kind: "post",
  authorHandle: "excluded",
  body: "common projection fixture body",
  savedAt: 1_788_390_000,
  savedAtIsExact: true,
  metrics: {},
  media: [],
  links: [],
  raw: { ownText: "excluded" },
});

describe("search result projection characterization", () => {
  test("keeps shared card fields aligned while preserving mode-specific excerpts and media", async () => {
    const db = openTestDb();
    await upsertItems(db, [
      projectionFixture(),
      excludedFixture("archived"),
      excludedFixture("removed"),
      excludedFixture("hidden", "tiktok"),
    ]);

    const rows = await db.select({ id: items.id, externalId: items.externalId }).from(items);
    const idFor = (externalId: string) => rows.find((row) => row.externalId === externalId)?.id ?? "";
    const richId = idFor("projection-rich");
    const archivedId = idFor("archived");
    const removedId = idFor("removed");
    const hiddenId = idFor("hidden");
    await tagItems(db, [richId], "architecture");
    const [architectureTag] = await db.select({ id: tags.id }).from(tags).where(eq(tags.label, "architecture"));
    if (!architectureTag) throw new Error("expected architecture tag");
    await db.update(tags).set({ color: "#123456" }).where(eq(tags.id, architectureTag.id));
    await setArchived(db, [archivedId], true);
    await db.update(items).set({ favorite: 1, note: "manual note" }).where(eq(items.id, richId));
    await db.update(items).set({ platformSaved: 0 }).where(eq(items.id, removedId));
    await setSourceEnabled(db, "tiktok", false);
    await db.update(media).set({ storedKey: "media/main" }).where(eq(media.originUrl, "https://cdn.test/main.jpg"));
    await db.update(media).set({ storedKey: "media/quote" }).where(eq(media.originUrl, "https://cdn.test/quote.jpg"));

    const filters = { source: "x", removed: "exclude" as const, limit: 10 };
    const lexical = await searchItemsPage(db, { query: "projection", ...filters, mark: ["[", "]"] });
    const list = await listItems(db, filters);
    const semantic = await hydrateSearchItems(db, [hiddenId, richId, richId, archivedId, removedId], filters);
    const hiddenOnly = await hydrateSearchItems(db, [hiddenId], { removed: "exclude" });

    expect(lexical.items).toHaveLength(1);
    expect(list.items).toHaveLength(1);
    expect(semantic).toHaveLength(1);
    expect(hiddenOnly).toHaveLength(0);

    const lexicalItem = lexical.items[0]!;
    const listItem = list.items[0]!;
    const semanticItem = semantic[0]!;
    const common = (item: typeof lexicalItem) => ({
      id: item.id,
      url: item.url,
      author: item.author,
      authorName: item.authorName,
      authorAvatar: item.authorAvatar,
      language: item.language,
      visibility: item.visibility,
      title: item.title,
      postedAt: item.postedAt,
      savedAt: item.savedAt,
      savedAtExact: item.savedAtExact,
      source: item.source,
      platformSaved: item.platformSaved,
      removedFromSourceAt: item.removedFromSourceAt,
      favorite: item.favorite,
      mediaCount: item.mediaCount,
      hasNote: item.hasNote,
      tags: item.tags,
      metrics: item.metrics,
    });

    const expectedCommon: ReturnType<typeof common> = {
      id: richId,
      url: "https://x.com/i/status/projection-rich",
      author: "jojo",
      authorName: "Jojo Mensah",
      authorAvatar: "https://cdn.test/jojo.png",
      language: "TypeScript",
      visibility: "public",
      title: "Projection fixture",
      postedAt: 1_788_390_123,
      savedAt: 1_788_390_456,
      savedAtExact: 1,
      source: "x",
      platformSaved: 1,
      removedFromSourceAt: null,
      favorite: true,
      mediaCount: 3,
      hasNote: true,
      tags: [{ label: "architecture", color: "#123456" }],
      metrics: { likes: 7 },
    };
    expect(common(lexicalItem)).toEqual(expectedCommon);
    expect(common(listItem)).toEqual(expectedCommon);
    expect(common(semanticItem)).toEqual(expectedCommon);
    expect(lexicalItem.excerpt).toContain("[");
    expect(typeof lexicalItem.score).toBe("number");
    expect(listItem.excerpt).toBe("shared own text");
    expect(listItem.score).toBe(0);
    expect(listItem.saveOrder).toBe(10);
    expect(semanticItem.excerpt).toBe("shared own text");
    expect(semanticItem.score).toBe(0);
    expect(lexicalItem.media).toEqual([
      { key: "media/main", kind: "image", url: "https://cdn.test/main.jpg" },
      { key: "media/quote", kind: "image", url: "https://cdn.test/quote.jpg" },
    ]);
    expect(semanticItem.media).toEqual(lexicalItem.media);
    expect(listItem.media).toEqual([
      { key: "media/main", kind: "image", url: "https://cdn.test/main.jpg" },
    ]);
    expect(listItem.quoted).toMatchObject({
      handle: "quoted",
      name: "Quoted Author",
      text: "quoted words",
      media: [{ key: "media/quote", kind: "image", url: "https://cdn.test/quote.jpg" }],
    });
    expect(lexical.nextCursor).toBeNull();
    expect(list.nextCursor).toBeNull();
  });

  test("malformed decoration falls back without dropping a valid card", async () => {
    const db = openTestDb();
    await upsertItems(db, [projectionFixture()]);
    const [row] = await db.select({ id: items.id }).from(items);
    if (!row) throw new Error("expected projection fixture row");
    const { id } = row;
    await db.update(items).set({
      metrics: "{malformed",
      raw: JSON.stringify({
        ownText: "shared own text",
        language: "TypeScript",
        visibility: "public",
        quoted: "{malformed",
      }),
    }).where(eq(items.id, id));

    const filters = { source: "x", removed: "exclude" as const, limit: 10 };
    const lexical = await searchItemsPage(db, { query: "projection", ...filters });
    const list = await listItems(db, filters);
    const semantic = await hydrateSearchItems(db, [id], filters);

    expect(lexical.items).toHaveLength(1);
    expect(list.items).toHaveLength(1);
    expect(semantic).toHaveLength(1);
    expect(lexical.items[0]).toMatchObject({ id, metrics: {} });
    expect(list.items[0]).toMatchObject({ id, metrics: {}, quoted: null });
    expect(semantic[0]).toMatchObject({ id, metrics: {} });
  });
});
