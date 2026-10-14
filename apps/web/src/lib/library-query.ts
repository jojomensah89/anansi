import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type ItemQuery, type ItemRow, type Page } from "./api.ts";

export interface LibraryPageRequest {
  query: string;
  options: ItemQuery;
  signal: AbortSignal;
}

export type LibraryPageLoader = (request: LibraryPageRequest) => Promise<Page>;

/** Poll active library data only while this browser tab is visible. */
export function libraryPollInterval(visibilityState: DocumentVisibilityState | undefined) {
  return visibilityState === "visible" ? 2_000 : false;
}

export const libraryFreshnessOptions = {
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: "always" as const,
  refetchOnReconnect: "always" as const,
  refetchInterval: () =>
    typeof document === "undefined" ? false : libraryPollInterval(document.visibilityState),
  refetchIntervalInBackground: false,
};

/** Infinite queries refetch every loaded cursor page during a poll. Keep their
 * automatic freshness events, and let the small stats query drive change
 * detection instead of polling a growing page chain. */
export const libraryPageFreshnessOptions = {
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: "always" as const,
  refetchOnReconnect: "always" as const,
};

export function libraryStatsFingerprint(stats: {
  items?: number;
  archived?: number;
  bySource?: Record<string, number>;
  captureRevision?: number;
}): string {
  return JSON.stringify([
    stats.items ?? null,
    stats.archived ?? null,
    stats.captureRevision ?? null,
    Object.entries(stats.bySource ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export function libraryStatsChanged(previous: string | null, next: string): boolean {
  return previous !== null && previous !== next;
}

export const libraryKeys = {
  all: ["library"] as const,
  pages: () => [...libraryKeys.all, "page"] as const,
  page: (query: string, options: ItemQuery) =>
    [...libraryKeys.pages(), { query, ...options }] as const,
  detail: (id: string) => [...libraryKeys.all, "detail", id] as const,
  stats: () => [...libraryKeys.all, "stats"] as const,
  collections: () => [...libraryKeys.all, "collections"] as const,
};

const defaultLoader: LibraryPageLoader = async ({ query, options, signal }) => {
  if (!query) return api.items(options, signal);
  const page = await api.search(query, options, signal);
  return {
    items: page.items.map((item) => ({ ...item, saveOrder: null } as ItemRow)),
    nextCursor: page.nextCursor,
    semantic: page.semantic,
  };
};

export function libraryQueryOptions(
  query: string,
  options: ItemQuery,
  loader: LibraryPageLoader = defaultLoader,
) {
  return {
    queryKey: libraryKeys.page(query, options),
    ...libraryPageFreshnessOptions,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) =>
      loader({ query, options: { ...options, cursor: pageParam }, signal }),
    getNextPageParam: (page: Page) => page.nextCursor ?? undefined,
    retry: 1,
    staleTime: 15_000,
  };
}

/** Final protection against a changing import returning an item on two pages. */
export function mergeUniquePages(pages: Page[] | undefined): ItemRow[] {
  const unique = new Map<string, ItemRow>();
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (!unique.has(item.id)) unique.set(item.id, item);
    }
  }
  return [...unique.values()];
}

export function useLibraryQuery({
  filters,
  query,
  order,
  hideRemoved,
  showNsfw = false,
  loader = defaultLoader,
}: {
  filters: ItemQuery;
  query: string;
  order: "saved" | "posted";
  hideRemoved: boolean;
  showNsfw?: boolean;
  loader?: LibraryPageLoader;
}) {
  const normalizedQuery = query.trim();
  const options = useMemo<ItemQuery>(
    () => ({
      ...filters,
      removed: filters.removed ?? (hideRemoved ? "exclude" : "include"),
      ...(filters.nsfw !== undefined ? { nsfw: filters.nsfw } : showNsfw ? { nsfw: true } : {}),
      order,
      limit: 60,
    }),
    [filters, hideRemoved, showNsfw, order],
  );
  const key = useMemo(() => libraryKeys.page(normalizedQuery, options), [normalizedQuery, options]);

  const result = useInfiniteQuery(libraryQueryOptions(normalizedQuery, options, loader));

  return {
    ...result,
    key,
    items: useMemo(() => mergeUniquePages(result.data?.pages), [result.data?.pages]),
    semantic: useMemo(() => {
      const pages = result.data?.pages ?? [];
      return [...pages].reverse().find((page) => page.semantic)?.semantic;
    }, [result.data?.pages]),
  };
}
