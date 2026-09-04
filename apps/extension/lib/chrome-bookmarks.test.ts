import { describe, expect, test } from "bun:test";
import {
  importCaptures,
  isMirrorable,
  mirrorableNodes,
  removalCaptures,
  toBookmarkCapture,
  type BookmarkNode,
} from "./chrome-bookmarks.ts";

const now = 1_788_390_000;

const bookmark = (patch: Partial<BookmarkNode> = {}): BookmarkNode => ({
  id: "n1",
  title: "Keyset pagination, properly",
  url: "https://example.dev/posts/keyset?utm_source=news#intro",
  dateAdded: 1_756_684_800_000,
  ...patch,
});

/** The shape Chrome actually hands back: roots that are folders. */
const tree = (): BookmarkNode[] => [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: [
          bookmark({ id: "a", url: "https://example.dev/a" }),
          bookmark({ id: "b", url: "https://example.dev/b" }),
          {
            id: "folder",
            title: "Reading",
            children: [
              bookmark({ id: "c", url: "https://example.dev/c" }),
              bookmark({ id: "js", url: "javascript:void(0)" }),
              { id: "empty", title: "Empty folder", children: [] },
            ],
          },
        ],
      },
    ],
  },
];

describe("isMirrorable", () => {
  test("http and https bookmarks are", () => {
    expect(isMirrorable(bookmark())).toBe(true);
    expect(isMirrorable(bookmark({ url: "http://localhost:3000/x" }))).toBe(true);
  });

  test("a folder is not — it is structure, not content", () => {
    expect(isMirrorable({ id: "f", title: "Reading", children: [] })).toBe(false);
  });

  test("neither is anything that is not a fetchable page", () => {
    for (const url of [
      "javascript:void(0)",
      "file:///C:/notes.html",
      "chrome://bookmarks",
      "data:text/html,hi",
      "not a url",
    ]) {
      expect(isMirrorable(bookmark({ url }))).toBe(false);
    }
  });
});

describe("mirrorableNodes", () => {
  test("flattens folders away and keeps only real bookmarks", () => {
    expect(mirrorableNodes(tree()).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  test("an empty tree yields nothing rather than throwing", () => {
    expect(mirrorableNodes([])).toEqual([]);
  });
});

describe("toBookmarkCapture", () => {
  test("identity is the canonical URL; the node id is the source link", async () => {
    const capture = await toBookmarkCapture(bookmark(), "save", now);

    expect(capture?.canonicalUrl).toBe("https://example.dev/posts/keyset");
    expect(capture?.sourceLink).toEqual({ kind: "chrome_bookmark", externalId: "n1" });
    expect(capture?.captureMethod).toBe("chrome_bookmark");
    expect(capture?.source).toBe("web");
  });

  test("the same page in two folders is one item and two links", async () => {
    const first = await toBookmarkCapture(bookmark({ id: "bar" }), "save", now);
    const second = await toBookmarkCapture(bookmark({ id: "reading" }), "save", now);

    // One item — removing either folder must not claim the page has gone.
    expect(second?.externalId).toBe(first?.externalId);
    expect(second?.sourceLink?.externalId).not.toBe(first?.sourceLink?.externalId);
  });

  test("a page clipped from the toolbar and bookmarked is not two items", async () => {
    // The toolbar path canonicalises the same way, so the identities meet.
    const bookmarked = await toBookmarkCapture(
      bookmark({ url: "https://example.dev/posts/keyset?utm_campaign=x" }),
      "save",
      now,
    );
    const plain = await toBookmarkCapture(
      bookmark({ id: "other", url: "https://example.dev/posts/keyset" }),
      "save",
      now,
    );

    expect(bookmarked?.externalId).toBe(plain?.externalId);
  });

  test("Chrome's own date is used, not the time the import ran", async () => {
    const capture = await toBookmarkCapture(bookmark(), "save", now);

    expect(capture?.observedAt).toBe(1_756_684_800);
    expect(capture?.normalizedItem?.savedAtIsExact).toBe(true);
  });

  test("a missing or absurd date falls back to now rather than lying", async () => {
    const none = await toBookmarkCapture(bookmark({ dateAdded: undefined }), "save", now);
    const future = await toBookmarkCapture(bookmark({ dateAdded: 9e15 }), "save", now);

    expect(none?.observedAt).toBe(now);
    expect(future?.observedAt).toBe(now);
  });

  test("an unsave carries no item content, because none is needed", async () => {
    const capture = await toBookmarkCapture(bookmark(), "unsave", now);

    expect(capture?.action).toBe("unsave");
    expect(capture?.normalizedItem).toBeUndefined();
    expect(capture?.sourceLink?.externalId).toBe("n1");
  });

  test("a folder or a bookmarklet produces nothing at all", async () => {
    expect(await toBookmarkCapture({ id: "f", children: [] }, "save", now)).toBeNull();
    expect(await toBookmarkCapture(bookmark({ url: "javascript:1" }), "save", now)).toBeNull();
  });

  test("the event id is derived, so one rename is one event", async () => {
    const first = await toBookmarkCapture(bookmark(), "save", now);
    const again = await toBookmarkCapture(bookmark({ title: "Renamed" }), "save", now);

    // Same node, same second: one event. The title rides along with it.
    expect(again?.eventId).toBe(first?.eventId);
  });
});

describe("removalCaptures", () => {
  test("removing one bookmark unsaves one link", async () => {
    const captures = await removalCaptures(bookmark(), now);

    expect(captures.length).toBe(1);
    expect(captures[0]?.action).toBe("unsave");
  });

  test("removing a folder unsaves everything inside it", async () => {
    // Chrome reports the folder and nothing else, so without walking the
    // subtree its contents would stay marked present forever.
    const folder: BookmarkNode = {
      id: "folder",
      title: "Reading",
      children: [
        bookmark({ id: "c1", url: "https://example.dev/c1" }),
        bookmark({ id: "c2", url: "https://example.dev/c2" }),
        { id: "nested", children: [bookmark({ id: "c3", url: "https://example.dev/c3" })] },
      ],
    };

    const captures = await removalCaptures(folder, now);

    expect(captures.map((c) => c.sourceLink?.externalId).sort()).toEqual(["c1", "c2", "c3"]);
    expect(captures.every((c) => c.action === "unsave")).toBe(true);
  });

  test("removing an empty folder is not an event", async () => {
    expect(await removalCaptures({ id: "f", children: [] }, now)).toEqual([]);
  });
});

describe("importCaptures", () => {
  test("the whole tree, as saves, with folders and junk left out", async () => {
    const captures = await importCaptures(tree(), now);

    expect(captures.length).toBe(3);
    expect(captures.every((c) => c.action === "save")).toBe(true);
    expect(captures.every((c) => c.normalizedItem !== undefined)).toBe(true);
  });

  test("an import of nothing is nothing, not a failure", async () => {
    expect(await importCaptures([], now)).toEqual([]);
  });
});
