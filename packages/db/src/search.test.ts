import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toFtsQuery } from "./search.ts";

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
