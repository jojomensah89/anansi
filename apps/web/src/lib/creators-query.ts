import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	api,
	type Creator,
	type CreatorPage,
	type CreatorQuery,
} from "./api.ts";

export type CreatorPageLoader = (
	options: CreatorQuery,
	signal: AbortSignal,
) => Promise<CreatorPage>;

export const creatorKeys = {
	all: ["creators"] as const,
	page: (query: string, source: string[]) =>
		[...creatorKeys.all, "page", { query, source }] as const,
};

const defaultLoader: CreatorPageLoader = (options, signal) =>
	api.creators(options, signal);

export function creatorQueryOptions(
	query: string,
	source: string[],
	loader: CreatorPageLoader = defaultLoader,
) {
	const normalizedQuery = query.trim();
	const normalizedSource = [...new Set(source)].sort();
	return {
		queryKey: creatorKeys.page(normalizedQuery, normalizedSource),
		initialPageParam: null as string | null,
		queryFn: ({
			pageParam,
			signal,
		}: {
			pageParam: string | null;
			signal: AbortSignal;
		}) =>
			loader(
				{
					query: normalizedQuery,
					source: normalizedSource,
					cursor: pageParam,
					limit: 40,
				},
				signal,
			),
		getNextPageParam: (page: CreatorPage) => page.nextCursor ?? undefined,
		retry: 1,
		staleTime: 15_000,
	};
}

export function mergeUniqueCreators(
	pages: CreatorPage[] | undefined,
): Creator[] {
	const unique = new Map<string, Creator>();
	for (const page of pages ?? []) {
		for (const creator of page.creators) {
			const key = `${creator.source}:${creator.authorHandle}`;
			if (!unique.has(key)) unique.set(key, creator);
		}
	}
	return [...unique.values()];
}

export function useCreatorsQuery(query: string, source: string[]) {
	const options = useMemo(
		() => creatorQueryOptions(query, source),
		[query, source],
	);
	const result = useInfiniteQuery(options);
	return {
		...result,
		creators: useMemo(
			() => mergeUniqueCreators(result.data?.pages),
			[result.data?.pages],
		),
		total: result.data?.pages[0]?.total ?? 0,
	};
}
