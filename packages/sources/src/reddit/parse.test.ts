import { describe, expect, test } from "bun:test";
import { parseSavedListing, savedListingCursor } from "./parse.ts";

/**
 * A saved listing as Reddit returns it: a post and a comment in one response,
 * which is the shape that makes this source different from the other two.
 *
 * Built from the documented Listing shape rather than captured from a live
 * account, so it is a contract test, not a recording. The first real import
 * should replace it with a scrubbed capture.
 */
const listing = {
  kind: "Listing",
  data: {
    after: "t1_kx9zzzz",
    children: [
      {
        kind: "t3",
        data: {
          id: "1abc23",
          name: "t3_1abc23",
          title: "Show HN style: I built a local-first bookmark search",
          selftext: "It runs against a SQLite file and exposes MCP tools.",
          url: "https://example.dev/anansi",
          permalink: "/r/selfhosted/comments/1abc23/show_hn_style/",
          subreddit: "selfhosted",
          author: "someone",
          created_utc: 1_770_000_000,
          score: 412,
          num_comments: 57,
          upvote_ratio: 0.96,
          is_self: false,
          over_18: false,
          thumbnail: "https://b.thumbs.redditmedia.com/abc.jpg",
          preview: {
            images: [{ source: { url: "https://preview.redd.it/abc.png?width=640&amp;crop=smart", width: 640, height: 360 } }],
          },
        },
      },
      {
        kind: "t1",
        data: {
          id: "kx9zzzz",
          name: "t1_kx9zzzz",
          body: "FTS5 external-content tables need the triggers or the index drifts.",
          link_title: "What is everyone using for full text search?",
          link_permalink: "https://www.reddit.com/r/sqlite/comments/9xyz/",
          permalink: "/r/sqlite/comments/9xyz/what_is_everyone/kx9zzzz/",
          subreddit: "sqlite",
          author: "[deleted]",
          created_utc: 1_772_000_000,
          score: 88,
        },
      },
      // Reddit includes tombstones for removed things; they have no identity.
      { kind: "t3", data: { title: "gone" } },
    ],
  },
};

const ctx = { importedAt: 1_800_000_000 };

describe("parseSavedListing", () => {
  const items = parseSavedListing(listing, ctx);

  test("parses both kinds and skips what has no identity", () => {
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.externalId)).toEqual(["t3_1abc23", "t1_kx9zzzz"]);
  });

  test("uses the fullname as the upsert key, not the bare id", () => {
    // t1_abc and t3_abc are different things and can collide on id alone.
    expect(items[0]!.externalId).toStartWith("t3_");
    expect(items[1]!.externalId).toStartWith("t1_");
  });

  test("a comment carries its thread title, or it is an orphaned fragment", () => {
    expect(items[1]!.title).toBe("What is everyone using for full text search?");
    expect(items[1]!.body).toContain("What is everyone using");
    expect(items[1]!.body).toContain("FTS5 external-content");
  });

  test("[deleted] is not an author", () => {
    expect(items[1]!.authorHandle).toBeUndefined();
    expect(items[0]!.authorHandle).toBe("someone");
  });

  test("an external link post keeps its destination", () => {
    expect(items[0]!.links).toEqual(["https://example.dev/anansi"]);
    // A comment links nowhere outward.
    expect(items[1]!.links).toEqual([]);
  });

  test("preview urls are html-unescaped, or they 403", () => {
    expect(items[0]!.media[0]!.originUrl).toBe("https://preview.redd.it/abc.png?width=640&crop=smart");
  });

  test("Reddit gives no saved-at, so it must not claim one", () => {
    expect(items[0]!.savedAtIsExact).toBe(false);
    expect(items[0]!.savedAt).toBe(ctx.importedAt);
  });

  test("save order follows listing position, newest first", () => {
    expect(items[0]!.saveOrder).toBeGreaterThan(items[1]!.saveOrder!);
  });

  test("cursor is the listing's after", () => {
    expect(savedListingCursor(listing)).toBe("t1_kx9zzzz");
    expect(savedListingCursor({ data: { after: null } })).toBeNull();
    expect(savedListingCursor({})).toBeNull();
  });

  test("an empty listing parses to nothing rather than throwing", () => {
    expect(parseSavedListing({ data: { children: [] } }, ctx)).toEqual([]);
    expect(parseSavedListing(null, ctx)).toEqual([]);
  });
});
