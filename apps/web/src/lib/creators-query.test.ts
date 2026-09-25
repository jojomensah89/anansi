import { describe, expect, test } from "bun:test";
import type { CreatorPage, CreatorQuery } from "./api.ts";
import { creatorQueryOptions, mergeUniqueCreators } from "./creators-query.ts";

const creator = (source: string, authorHandle: string) => ({
	authorHandle,
	authorName: null,
	authorAvatar: null,
	source,
	saves: 1,
	lastPosted: null,
});

describe("creator query", () => {
	test("keys and requests include normalized search and source dependencies", async () => {
		let request: CreatorQuery | undefined;
		const loader = async (options: CreatorQuery): Promise<CreatorPage> => {
			request = options;
			return {
				creators: [],
				nextCursor: null,
				total: 0,
				singleSaveCount: 0,
				topTenSaves: 0,
			};
		};
		const options = creatorQueryOptions(
			"  Anansi  ",
			["reddit", "x", "reddit"],
			loader,
		);
		expect(options.queryKey).toEqual([
			"creators",
			"page",
			{ query: "Anansi", source: ["reddit", "x"] },
		]);
		await options.queryFn({
			pageParam: null,
			signal: new AbortController().signal,
		});
		expect(request).toEqual({
			query: "Anansi",
			source: ["reddit", "x"],
			cursor: null,
			limit: 40,
		});
	});

	test("merges pages without duplicating a creator group", () => {
		const pages: CreatorPage[] = [
			{
				creators: [creator("x", "anansi"), creator("reddit", "anansi")],
				nextCursor: "next",
				total: 3,
				singleSaveCount: 0,
				topTenSaves: 2,
			},
			{
				creators: [creator("x", "anansi"), creator("x", "arachne")],
				nextCursor: null,
				total: 3,
				singleSaveCount: 0,
				topTenSaves: 2,
			},
		];
		expect(
			mergeUniqueCreators(pages).map(
				(row) => `${row.source}:${row.authorHandle}`,
			),
		).toEqual(["x:anansi", "reddit:anansi", "x:arachne"]);
	});
});
