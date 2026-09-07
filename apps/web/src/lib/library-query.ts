import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type ItemQuery, type ItemRow, type Page } from "./api.ts";

export interface LibraryPageRequest {
  query: string;
  options: ItemQuery;
  signal: AbortSignal;
}

export type LibraryPageLoader = (request: LibraryPageRequest) => Promise<Page>;

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
  loader = defaultLoader,
}: {
  filters: ItemQuery;
  query: string;
  order: "saved" | "posted";
  hideRemoved: boolean;
  loader?: LibraryPageLoader;
}) {
  const normalizedQuery = query.trim();
  const options = useMemo<ItemQuery>(
    () => ({
      ...filters,
      removed: filters.removed ?? (hideRemoved ? "exclude" : "include"),
      order,
      limit: 60,
    }),
    [filters, hideRemoved, order],
  );

  const result = useInfiniteQuery(libraryQueryOptions(normalizedQuery, options, loader));

  return {
    ...result,
    items: useMemo(() => mergeUniquePages(result.data?.pages), [result.data?.pages]),
    semantic: useMemo(() => {
      const pages = result.data?.pages ?? [];
      return [...pages].reverse().find((page) => page.semantic)?.semantic;
    }, [result.data?.pages]),
  };
}
