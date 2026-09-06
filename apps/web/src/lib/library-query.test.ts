import { describe, expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import type { ItemRow, Page } from "./api.ts";
import { libraryQueryOptions, mergeUniquePages, type LibraryPageLoader } from "./library-query.ts";

function row(id: string, source = "x"): ItemRow {
  return { id, source, url: `https://example.com/${id}`, author: null, authorName: null, title: id, excerpt: id, postedAt: null, savedAt: 1, savedAtExact: 1, score: 0, saveOrder: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("library query", () => {
  test("deduplicates an item returned on adjacent import-changing pages", () => {
    expect(mergeUniquePages([
      { items: [row("a"), row("b")], nextCursor: "next" },
      { items: [row("b"), row("c")], nextCursor: null },
    ]).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  test("a delayed old filter cannot replace the current filter", async () => {
    const oldPage = deferred<Page>();
    const newPage = deferred<Page>();
    const aborted: string[] = [];
    const loader: LibraryPageLoader = ({ options, signal }) => {
      const source = options.source?.[0] ?? "all";
      signal.addEventListener("abort", () => aborted.push(source));
      return source === "x" ? oldPage.promise : newPage.promise;
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(client, libraryQueryOptions("", { source: ["x"] }, loader));
    const seen: string[][] = [];
    const unsubscribe = observer.subscribe((result) => {
      const ids = mergeUniquePages(result.data?.pages).map((item) => item.id);
      if (ids.length) seen.push(ids);
    });

    observer.setOptions(libraryQueryOptions("", { source: ["github"] }, loader));
    newPage.resolve({ items: [row("new", "github")], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    oldPage.resolve({ items: [row("old")], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborted).toContain("x");
    expect(seen.at(-1)).toEqual(["new"]);
    expect(seen).not.toContainEqual(["old"]);
    unsubscribe();
  });
});
