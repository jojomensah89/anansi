import { describe, expect, test } from "bun:test";
import { validateLibrarySearch } from "./library-search.ts";

/**
 * The URL is input from outside.
 *
 * Anyone can type one, edit one, or paste one they were sent, so the validator
 * has to treat every param as hostile: an unknown view or media value would
 * otherwise reach the query, and an unbounded list would reach the SQL.
 */
describe("validateLibrarySearch", () => {
  test("a comma list becomes a list", () => {
		expect(validateLibrarySearch({ source: "x,instagram" }).source).toEqual([
		"x",
		"instagram",
		]);
  });

  test("one value is still a list, so the query layer sees one shape", () => {
    expect(validateLibrarySearch({ source: "reddit" }).source).toEqual(["reddit"]);
  });

  test("an array survives, for a URL built by the router itself", () => {
    expect(validateLibrarySearch({ author: ["ada", "kwame"] }).author).toEqual([
      "ada",
      "kwame",
    ]);
  });

  test("absent is undefined, never an empty list", () => {
    const out = validateLibrarySearch({});

    expect(out.source).toBeUndefined();
    expect(out.author).toBeUndefined();
    expect(out.type).toBeUndefined();
    expect(out.tag).toBeUndefined();
  });

  test("an empty or whitespace param is absent too", () => {
    expect(validateLibrarySearch({ source: "" }).source).toBeUndefined();
    expect(validateLibrarySearch({ source: " , , " }).source).toBeUndefined();
  });

  test("whitespace around values is trimmed", () => {
		expect(validateLibrarySearch({ source: " x , instagram " }).source).toEqual([
		"x",
		"instagram",
		]);
  });

  test("duplicates collapse, so a hand-edited URL cannot bloat the query", () => {
    expect(validateLibrarySearch({ source: "x,x,x" }).source).toEqual(["x"]);
  });

  test("an absurdly long value is dropped rather than passed on", () => {
    const long = "a".repeat(500);

    expect(validateLibrarySearch({ source: `x,${long}` }).source).toEqual(["x"]);
  });

  test("only the supported views are accepted", () => {
    expect(validateLibrarySearch({ view: "timeline" }).view).toBe("timeline");
    expect(validateLibrarySearch({ view: "mosaic" }).view).toBeUndefined();
    expect(validateLibrarySearch({ view: "nonsense" }).view).toBeUndefined();
    expect(validateLibrarySearch({ view: 7 }).view).toBeUndefined();
  });

  test("only the four media values are accepted", () => {
    expect(validateLibrarySearch({ media: "video" }).media).toBe("video");
    expect(validateLibrarySearch({ media: "drop table" }).media).toBeUndefined();
  });

  test("archived is only true when it says so", () => {
    expect(validateLibrarySearch({ archived: true }).archived).toBe(true);
    expect(validateLibrarySearch({ archived: "true" }).archived).toBe(true);
    expect(validateLibrarySearch({ archived: "false" }).archived).toBeUndefined();
    expect(validateLibrarySearch({ archived: 1 }).archived).toBeUndefined();
  });

  test("junk types are ignored rather than thrown on", () => {
    const out = validateLibrarySearch({
      source: 42,
      author: null,
      type: { nope: true },
      tag: [1, 2, "real"],
    });

    expect(out.source).toBeUndefined();
    expect(out.author).toBeUndefined();
    expect(out.type).toBeUndefined();
    expect(out.tag).toEqual(["real"]);
  });

  test("search and open item are bounded URL state", () => {
    expect(validateLibrarySearch({ q: "  saved design  ", item: "abc" })).toMatchObject({
      q: "saved design",
      item: "abc",
    });
    expect(validateLibrarySearch({ q: " ", item: 42 }).q).toBeUndefined();
    expect(validateLibrarySearch({ q: "x".repeat(800) }).q).toHaveLength(500);
  });

  test("at-source takes only the two values that mean something", () => {
    expect(validateLibrarySearch({ removed: "only" }).removed).toBe("only");
    expect(validateLibrarySearch({ removed: "exclude" }).removed).toBe("exclude");
    // "include everything" is the absence of the filter, not a value.
    expect(validateLibrarySearch({ removed: "include" }).removed).toBeUndefined();
    expect(validateLibrarySearch({ removed: "1 or 1=1" }).removed).toBeUndefined();
    expect(validateLibrarySearch({ removed: 7 }).removed).toBeUndefined();
  });
});
