import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type IngestItem, upsertItems } from "./queries.ts";
import { sourceHealth, toFtsQuery } from "./search.ts";
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
