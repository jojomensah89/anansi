import type { AnansiDb, ItemDetail, ListOptions, SearchHit } from "@anansi/db";
import {
	findByAuthor,
	getItem,
	getItems,
	libraryStats,
	listItems,
	listTags,
	recentSaves,
	searchItems,
} from "@anansi/db";
import {
	VISIBLE_LIBRARY_SOURCES,
	type VisibleLibrarySource,
} from "@anansi/sources";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MCP_TOOL_CATALOG } from "./catalog.ts";

/** Excerpts, never full bodies: a shortlist should leave room for reasoning. */
const EXCERPT_LIMIT = 300;

/** Preserve the MCP enum's historical wire order while deriving membership. */
const MCP_SOURCE_VALUES = [
	...VISIBLE_LIBRARY_SOURCES.filter((source) => source !== "web"),
	...VISIBLE_LIBRARY_SOURCES.filter((source) => source === "web"),
] as [VisibleLibrarySource, ...VisibleLibrarySource[]];
export const MCP_SOURCES = z.enum(MCP_SOURCE_VALUES);

const MCP_CONTENT_TYPES = z.enum([
	"post",
	"video",
	"article",
	"comment",
	"repo",
	"thread",
]);
const MCP_MEDIA = z.enum(["any", "image", "video", "none"]);
const MCP_REMOVED = z.enum(["include", "exclude", "only"]);
const MCP_ORDER = z.enum(["saved", "posted"]);
const ISO_DATE_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function isIsoDate(value: string): boolean {
	const match = ISO_DATE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth[month - 1]! &&
		Number.isFinite(Date.parse(value))
	);
}

const ISO_DATE = z
	.string()
	.refine(isIsoDate, "must be a valid ISO date or datetime");

function trim(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= EXCERPT_LIMIT
		? clean
		: `${clean.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function iso(unix: number | null | undefined): string | null {
	return unix == null ? null : new Date(unix * 1000).toISOString();
}

function unix(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Math.floor(Date.parse(value) / 1000);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keep the public projection stable and explicit; never leak raw provider data. */
function hit(row: SearchHit) {
	return {
		id: row.id,
		url: row.url,
		author: row.author,
		author_name: row.authorName,
		author_avatar: row.authorAvatar ?? null,
		title: row.title,
		excerpt: trim(row.excerpt),
		source: row.source,
		language: row.language ?? null,
		visibility: row.visibility ?? null,
		posted_at: iso(row.postedAt),
		saved_at: iso(row.savedAt),
		saved_at_is_exact: row.savedAtExact === 1,
		score: row.score,
		favorite: row.favorite ?? false,
		platform_saved: row.platformSaved !== 0,
		removed_from_source_at: iso(row.removedFromSourceAt),
		media_count: row.mediaCount ?? 0,
		has_note: row.hasNote ?? false,
		tags: row.tags ?? [],
		media: row.media ?? [],
		metrics: row.metrics ?? {},
	};
}

function listHit(row: Awaited<ReturnType<typeof listItems>>["items"][number]) {
	return {
		...hit(row),
		save_order: row.saveOrder ?? null,
		quoted: row.quoted
			? {
					handle: row.quoted.handle,
					name: row.quoted.name,
					avatar: row.quoted.avatar,
					text: trim(row.quoted.text),
					url: row.quoted.url,
					media: row.quoted.media,
				}
			: null,
	};
}

function detail(item: ItemDetail) {
	return {
		id: item.id,
		url: item.url,
		source: item.source,
		author: item.author,
		author_name: item.authorName,
		author_avatar: item.authorAvatar,
		title: item.title,
		full_text: item.fullText,
		article_text: item.articleText,
		article_format: item.articleFormat,
		content_truncated: item.contentTruncated,
		highlights: item.highlights,
		note: item.note,
		favorite: item.favorite,
		tags: item.tags,
		tag_meta: item.tagMeta,
		archived: item.archived,
		posted_at: iso(item.postedAt),
		saved_at: iso(item.savedAt),
		saved_at_is_exact: item.savedAtExact,
		platform_saved: item.platformSaved,
		removed_from_source_at: iso(item.removedFromSourceAt),
		metrics: item.metrics,
		media: item.media.map((media) => ({
			kind: media.kind,
			origin_url: media.originUrl,
			stored_key: media.storedKey,
			width: media.width,
			height: media.height,
		})),
		links: item.links,
		quoted: item.quoted
			? {
					handle: item.quoted.handle,
					name: item.quoted.name,
					avatar: item.quoted.avatar,
					text: item.quoted.text,
					url: item.quoted.url,
					media: item.quoted.media.map((media) => ({
						kind: media.kind,
						origin_url: media.originUrl,
						stored_key: media.storedKey,
					})),
				}
			: null,
		thread: item.thread.map((thread) => ({
			id: thread.id,
			url: thread.url,
			author: thread.author,
			excerpt: trim(thread.excerpt),
		})),
	};
}

const json = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const sourceList = z.union([MCP_SOURCES, z.array(MCP_SOURCES).min(1).max(4)]);
const textList = z.union([
	z.string().trim().min(1).max(200),
	z.array(z.string().trim().min(1).max(200)).min(1).max(20),
]);
const typeList = z.union([
	MCP_CONTENT_TYPES,
	z.array(MCP_CONTENT_TYPES).min(1).max(6),
]);

const browseSchema = {
	source: sourceList.optional(),
	author: textList.optional(),
	tag: textList.optional(),
	media: MCP_MEDIA.optional(),
	content_type: typeList.optional(),
	archived: z.boolean().default(false),
	removed: MCP_REMOVED.default("include"),
	favorite: z.boolean().optional(),
	since: ISO_DATE.optional(),
	until: ISO_DATE.optional(),
	order: MCP_ORDER.default("saved"),
	cursor: z.string().max(2000).optional(),
	limit: z.number().int().min(1).max(50).default(20),
};

function listOptions(args: {
	source?: VisibleLibrarySource | VisibleLibrarySource[];
	author?: string | string[];
	tag?: string | string[];
	media?: string;
	content_type?: string | string[];
	archived?: boolean;
	removed?: "include" | "exclude" | "only";
	favorite?: boolean;
	since?: string;
	until?: string;
	order?: "saved" | "posted";
	cursor?: string;
	limit?: number;
}): ListOptions {
	return {
		source: args.source,
		author: args.author,
		tag: args.tag,
		media: args.media,
		contentType: args.content_type,
		archived: args.archived,
		removed: args.removed,
		favorite: args.favorite,
		since: unix(args.since),
		until: unix(args.until),
		order: args.order,
		cursor: args.cursor,
		limit: args.limit,
	};
}

/** Register the same read-only surface for local stdio and a future D1 Worker. */
export function registerTools(server: McpServer, db: AnansiDb): void {
	server.registerTool(
		MCP_TOOL_CATALOG[0].name,
		{
			title: "Search saved posts",
			description:
				"Keyword search across every visible saved item. Returns ranked excerpts and source URLs. " +
				"Matching is keyword-based with English stemming; a misspelling returns no result.",
			inputSchema: {
				query: z
					.string()
					.trim()
					.min(1)
					.max(500)
					.describe("Words to search for. A trailing * does prefix matching."),
				source: MCP_SOURCES.optional(),
				author: z.string().trim().min(1).max(200).optional(),
				since: ISO_DATE.optional(),
				limit: z.number().int().min(1).max(50).default(10),
			},
		},
		async ({ query, source, author, since, limit }) => {
			const rows = await searchItems(db, {
				query,
				source,
				author,
				since: unix(since),
				limit,
			});
			return json({ query, count: rows.length, results: rows.map(hit) });
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[1].name,
		{
			title: "Get one saved item",
			description:
				"Pull one visible saved item into context with its text, media, links, and thread.",
			inputSchema: {
				id: z
					.string()
					.trim()
					.min(1)
					.max(200)
					.describe("The id from a search_saved result."),
			},
		},
		async ({ id }) => {
			const item = await getItem(db, id);
			return item
				? json(detail(item))
				: json({ error: `no item with id ${id}` });
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[2].name,
		{
			title: "Get several saved items",
			description:
				"Pull up to twenty visible saved items into context in the requested order.",
			inputSchema: {
				ids: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
			},
		},
		async ({ ids }) => {
			const result = await getItems(db, ids);
			return json({
				items: result.items.map(detail),
				missing_ids: result.missingIds,
			});
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[3].name,
		{
			title: "Browse saved items",
			description:
				"Browse visible saved items with filters and an opaque keyset cursor.",
			inputSchema: browseSchema,
		},
		async (args) => {
			const result = await listItems(db, listOptions(args));
			return json({
				count: result.items.length,
				next_cursor: result.nextCursor,
				results: result.items.map(listHit),
			});
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[4].name,
		{
			title: "Recently saved",
			description: "List the newest visible saved items in bookmark order.",
			inputSchema: {
				source: MCP_SOURCES.optional(),
				limit: z.number().int().min(1).max(50).default(20),
			},
		},
		async ({ source, limit }) => {
			const rows = await recentSaves(db, source, limit);
			return json({ count: rows.length, results: rows.map(hit) });
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[5].name,
		{
			title: "Everything from one author",
			description: "List visible saves from one handle, newest first.",
			inputSchema: {
				handle: z
					.string()
					.trim()
					.min(1)
					.max(200)
					.describe("Handle with or without the @."),
				limit: z.number().int().min(1).max(50).default(20),
			},
		},
		async ({ handle, limit }) => {
			const cleanHandle = handle.replace(/^@/, "");
			const rows = await findByAuthor(db, cleanHandle, limit);
			return json({
				handle: cleanHandle,
				count: rows.length,
				results: rows.map(hit),
			});
		},
	);

	server.registerTool(
		MCP_TOOL_CATALOG[6].name,
		{
			title: "List saved tags",
			description: "List visible tag vocabulary and usage counts.",
			inputSchema: {},
		},
		async () => json({ tags: await listTags(db) }),
	);

	server.registerTool(
		MCP_TOOL_CATALOG[7].name,
		{
			title: "Library statistics",
			description:
				"Summarize visible saves by source, archive state, and media.",
			inputSchema: {},
		},
		async () => json(await libraryStats(db)),
	);
}
