import { describe, expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ItemRow, Page } from "./api.ts";
import { libraryFreshnessOptions, libraryPageFreshnessOptions, libraryPollInterval, libraryQueryOptions, libraryStatsChanged, libraryStatsFingerprint, mergeUniquePages, type LibraryPageLoader } from "./library-query.ts";

function row(id: string, source = "x"): ItemRow {
  return { id, source, url: `https://example.com/${id}`, author: null, authorName: null, title: id, excerpt: id, postedAt: null, savedAt: 1, savedAtExact: 1, score: 0, saveOrder: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("library query", () => {
  test("polls every two seconds only while the document is visible", () => {
    expect(libraryPollInterval("visible")).toBe(2_000);
    expect(libraryPollInterval("hidden")).toBe(false);
    expect(libraryPollInterval(undefined)).toBe(false);
    expect(libraryFreshnessOptions.refetchOnMount).toBe("always");
    expect(libraryFreshnessOptions.refetchOnWindowFocus).toBe("always");
    expect(libraryFreshnessOptions.refetchOnReconnect).toBe("always");
    expect(libraryFreshnessOptions.refetchIntervalInBackground).toBe(false);
    expect(libraryPageFreshnessOptions.refetchOnMount).toBe("always");
    expect(libraryPageFreshnessOptions.refetchOnWindowFocus).toBe("always");
    expect(libraryPageFreshnessOptions.refetchOnReconnect).toBe("always");
  });

  test("keeps a 20-page chain quiet and refreshes it when a capture changes without changing counts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    const loader: LibraryPageLoader = async ({ options }) => {
      calls += 1;
      const pageNumber = options.cursor ? Number(options.cursor) : 0;
      return {
        items: [row(`page-${pageNumber}`)],
        nextCursor: pageNumber < 19 ? String(pageNumber + 1) : null,
      };
    };
    const options = libraryQueryOptions("", {}, loader);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let page = 1; page < 20; page += 1) await observer.fetchNextPage();

    expect(calls).toBe(20);
    expect("refetchInterval" in options).toBe(false);
    const sameCounts = libraryStatsFingerprint({ items: 20, archived: 0, bySource: { x: 20 }, captureRevision: 1 });
    let previousFingerprint: string | null = null;
    const initialStats = libraryStatsFingerprint({ items: 20, archived: 0, bySource: { x: 20 }, captureRevision: 1 });
    expect(initialStats).toBe(sameCounts);
    expect(libraryStatsChanged(previousFingerprint, initialStats)).toBe(false);
    previousFingerprint = initialStats;
    const unchangedStats = libraryStatsFingerprint({ items: 20, archived: 0, bySource: { x: 20 }, captureRevision: 1 });
    expect(libraryStatsChanged(previousFingerprint, unchangedStats)).toBe(false);
    expect(calls).toBe(20);

    const changedStats = libraryStatsFingerprint({ items: 20, archived: 0, bySource: { x: 20 }, captureRevision: 2 });
    expect(libraryStatsChanged(previousFingerprint, changedStats)).toBe(true);

    if (libraryStatsChanged(previousFingerprint, changedStats)) {
      await client.invalidateQueries({ queryKey: options.queryKey, exact: true });
    }
    expect(calls).toBe(40);
    unsubscribe();
    client.clear();
  });

  test("refetches cached library data on mount and keeps focus and reconnect refetch enabled", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["library", "freshness-test"],
      queryFn: async () => ++calls,
      staleTime: 60_000,
      ...libraryFreshnessOptions,
    });
    client.setQueryData(["library", "freshness-test"], 0);
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(observer.options.refetchOnWindowFocus).toBe("always");
    expect(observer.options.refetchOnReconnect).toBe("always");

    unsubscribe();
    client.clear();
  });

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
