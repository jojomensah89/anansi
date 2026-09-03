import { describe, expect, test } from "bun:test";
import { validateLibrarySearch } from "./index.tsx";

/**
 * The URL is input from outside.
 *
 * Anyone can type one, edit one, or paste one they were sent, so the validator
 * has to treat every param as hostile: an unknown view or media value would
 * otherwise reach the query, and an unbounded list would reach the SQL.
 */
describe("validateLibrarySearch", () => {
  test("a comma list becomes a list", () => {
    expect(validateLibrarySearch({ source: "x,tiktok" }).source).toEqual([
      "x",
      "tiktok",
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
    expect(validateLibrarySearch({ source: " x , tiktok " }).source).toEqual([
      "x",
      "tiktok",
    ]);
  });

  test("duplicates collapse, so a hand-edited URL cannot bloat the query", () => {
    expect(validateLibrarySearch({ source: "x,x,x" }).source).toEqual(["x"]);
  });

  test("an absurdly long value is dropped rather than passed on", () => {
    const long = "a".repeat(500);

    expect(validateLibrarySearch({ source: `x,${long}` }).source).toEqual(["x"]);
  });

  test("only the four views are accepted", () => {
    expect(validateLibrarySearch({ view: "timeline" }).view).toBe("timeline");
    expect(validateLibrarySearch({ view: "mosaic" }).view).toBe("mosaic");
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
});
