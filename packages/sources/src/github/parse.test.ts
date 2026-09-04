import { describe, expect, test } from "bun:test";
import { parseStarredPage } from "./parse.ts";

const raw = await Bun.file("apps/cli/fixtures/github/starred-page.json").json();
const ctx = { importedAt: 1_800_000_000 };

describe("parseStarredPage", () => {
	const items = parseStarredPage(raw, ctx);

	test("produces one NormalizedItem per starred repo", () => {
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.title)).toEqual([
			"firecrawl/firecrawl",
			"mastra-ai/mastra",
		]);
	});

	test("starred_at becomes an exact saved_at — the first in the library", () => {
		const [firecrawl] = items;
		expect(firecrawl!.savedAtIsExact).toBe(true);
		expect(firecrawl!.savedAt).toBe(
			Math.floor(Date.parse("2026-07-12T09:14:03Z") / 1000),
		);
		// and it is the ordering key too, so recent_saves is right for this source
		expect(firecrawl!.saveOrder).toBe(firecrawl!.savedAt);
	});

	test("README head is appended to body, description first", () => {
		const body = items[0]!.body;
		expect(body.startsWith("Turn entire websites")).toBe(true);
		expect(body).toContain("Empower your AI apps");
	});

	test("a repo without a README still gets a body", () => {
		expect(items[1]!.body).toBe(
			"The TypeScript AI agent framework. Assistants, RAG, observability. Supports any LLM.",
		);
	});

	test("normalized owner/repository is the upsert key", () => {
		expect(items[0]!.externalId).toBe("firecrawl/firecrawl");
	});

	test("extension and API records normalize to the same repository", () => {
		const extension = parseStarredPage(
			{
				schemaVersion: 1,
				pageType: "github_stars",
				repositories: [
					{
						identity: "firecrawl/firecrawl",
						fullName: "Firecrawl/Firecrawl",
						owner: "Firecrawl",
						name: "Firecrawl",
						url: "https://github.com/Firecrawl/Firecrawl",
						description: "Turn entire websites into LLM-ready data.",
						language: "TypeScript",
						ownerAvatar: "https://avatars.githubusercontent.com/u/123?v=4",
						visibility: "private",
						stars: 63_400,
						forks: 5_210,
						starredAt: "2026-07-12T09:14:03Z",
					},
				],
			},
			ctx,
		);

		expect(extension).toHaveLength(1);
		expect(extension[0]).toMatchObject({
			externalId: items[0]!.externalId,
			url: "https://github.com/Firecrawl/Firecrawl",
			authorHandle: "Firecrawl",
			authorAvatar: "https://avatars.githubusercontent.com/u/123?v=4",
			title: "Firecrawl/Firecrawl",
			savedAt: items[0]!.savedAt,
			savedAtIsExact: true,
			metrics: { stars: 63_400, forks: 5_210 },
			raw: {
				language: "TypeScript",
				visibility: "private",
			},
		});
	});

	test("metrics fall back when subscribers_count is absent", () => {
		expect(items[0]!.metrics.watchers).toBe(402);
		expect(items[1]!.metrics.watchers).toBe(120);
		expect(items[0]!.metrics.stars).toBe(63400);
	});

	test("a null homepage does not become a link", () => {
		expect(items[1]!.links).toEqual(["https://github.com/mastra-ai/mastra"]);
		expect(items[0]!.links).toContain("https://firecrawl.dev");
	});

	test("tolerates a bare repo array without the star+json wrapper", () => {
		const bare = parseStarredPage(
			raw.starred.map((e: { repo: unknown }) => e.repo),
			ctx,
		);
		expect(bare).toHaveLength(2);
		// No starred_at available, so it must say so rather than invent one.
		expect(bare[0]!.savedAtIsExact).toBe(false);
		expect(bare[0]!.savedAt).toBe(ctx.importedAt);
	});

	test("skips entries with no repository identity", () => {
		expect(
			parseStarredPage({ starred: [{ repo: { node_id: "repo-node" } }] }, ctx),
		).toHaveLength(0);
	});

	test("skips malformed extension identities and preserves an empty valid page", () => {
		expect(
			parseStarredPage(
				{
					schemaVersion: 1,
					pageType: "github_stars",
					repositories: [
						{
							identity: "profile-only",
							fullName: "profile-only",
							url: "https://github.com/profile-only",
						},
					],
				},
				ctx,
			),
		).toEqual([]);
		expect(
			parseStarredPage(
				{
					schemaVersion: 1,
					pageType: "github_stars",
					repositories: [],
				},
				ctx,
			),
		).toEqual([]);
	});

	test("treats malformed page collections as empty", () => {
		expect(parseStarredPage({ starred: "not-an-array", readmes: [] }, ctx)).toEqual([]);
	});
});
