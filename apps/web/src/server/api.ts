import {
	creators,
	extensionHealth,
	findByAuthor,
	getItem,
	disabledSources,
	libraryStats,
	listItems,
	listTags,
	setArchived,
	setSourceEnabled,
	tagItems,
	sourceHealth,
	recentSaves,
	recordExtensionHeartbeat,
	searchItems,
	InvalidListCursorError,
} from "@anansi/db";
import type { AnansiDb } from "@anansi/db";
import { parseExtensionHeartbeat } from "@anansi/sources";
import { fetchPendingMedia, readMedia, type MediaSource } from "./media.ts";
import { ingestCapture } from "./ingest.ts";
import {
	isToggleableSource,
	sourceCatalogueResponse,
} from "./source-catalog.ts";

/**
 * The HTTP surface, as plain Request -> Response.
 *
 * Deliberately framework-agnostic: the TanStack route files are three-line
 * wrappers over these, so the routing library's API can churn without
 * touching anything that matters, and these are testable with a bare
 * `new Request(...)`.
 *
 * Every one of them calls the same function the MCP tool calls. That is the
 * spec's rule, and it holds because both import from @anansi/db rather than
 * from each other.
 *
 * The routes are a table rather than a chain of ifs. That started as a
 * complexity complaint and turned out to be the better shape anyway: matching
 * happens once, in one place, so a handler cannot accidentally depend on which
 * checks happened to run above it.
 */

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

/**
 * Number(null) is 0, not NaN — which silently turned an absent ?cursor into
 * cursor=0 and made /api/items return an empty page forever. Absent has to be
 * checked before parsing, not after.
 */
const num = (value: string | null, fallback?: number) => {
	if (value === null || value.trim() === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

export interface ApiEnv {
	db: AnansiDb;
	media?: MediaSource;
	/** Shared secret for /api/ingest. Absent means ingest is closed. */
	ingestToken?: string;
}

/** Everything a handler is allowed to know, resolved once by the dispatcher. */
interface Ctx {
	env: ApiEnv;
	request: Request;
	url: URL;
	q: URLSearchParams;
	/** Captures from a pattern route, in order. */
	params: string[];
}

interface Route {
	method: "GET" | "POST";
	/** An exact path, or a pattern whose captures become `params`. */
	path: string | RegExp;
	handle: (ctx: Ctx) => Response | Promise<Response>;
}

function authorizeExtension(env: ApiEnv, request: Request): Response | null {
	if (!env.ingestToken)
		return json({ error: "extension access is not configured" }, 503);
	const auth = request.headers.get("authorization") ?? "";
	return auth === `Bearer ${env.ingestToken}`
		? null
		: json({ error: "unauthorized" }, 401);
}

/* --------------------------------------------------------- handlers --- */

// Served from our own copy, never hot-linked: a deleted post still renders,
// and no request from the library tells the platform what you are reading.
const mediaRoute: Route = {
	method: "GET",
	path: /^\/api\/media\/(.+)$/,
	handle: ({ env, params }) =>
		readMedia(env.media ?? {}, decodeURIComponent(params[0] ?? "")),
};

const itemsRoute: Route = {
	method: "GET",
	path: "/api/items",
	handle: async ({ env, q }) => {
		try {
			return json(
				await listItems(env.db, {
					cursor: q.get("cursor") ?? undefined,
					// Repeated params, so ?source=x&source=tiktok is "either of these".
					// getAll returns [] for an absent param, which the query layer
					// reads as no filter at all rather than as a filter matching none.
					source: q.getAll("source"),
					author: q.getAll("author"),
					media: q.get("media") ?? undefined,
					contentType: q.getAll("type"),
					tag: q.getAll("tag"),
					archived: q.get("archived") === "1",
					removed: (["exclude", "only"] as const).find(
						(v) => v === q.get("removed"),
					),
					order: q.get("order") === "posted" ? "posted" : "saved",
					limit: num(q.get("limit"), 50),
				}),
			);
		} catch (error) {
			if (error instanceof InvalidListCursorError)
				return json({ error: error.message }, 400);
			throw error;
		}
	},
};

const itemRoute: Route = {
	method: "GET",
	path: /^\/api\/items\/([\w-]+)$/,
	handle: async ({ env, params }) => {
		const found = await getItem(env.db, params[0] ?? "");
		return found ? json(found) : json({ error: "not found" }, 404);
	},
};

const searchRoute: Route = {
	method: "GET",
	path: "/api/search",
	handle: async ({ env, q }) => {
		const query = q.get("q") ?? "";
		if (!query.trim()) return json({ error: "q is required" }, 400);
		return json({
			query,
			results: await searchItems(env.db, {
				query,
				source: q.getAll("source"),
				author: q.getAll("author"),
				limit: num(q.get("limit"), 20),
			}),
		});
	},
};

const recentRoute: Route = {
	method: "GET",
	path: "/api/recent",
	handle: async ({ env, q }) =>
		json({
			results: await recentSaves(
				env.db,
				q.get("source") ?? undefined,
				num(q.get("limit"), 20),
			),
		}),
};

const authorsRoute: Route = {
	method: "GET",
	path: "/api/authors",
	handle: async ({ env, q }) => {
		const handle = q.get("handle");
		if (!handle) return json({ error: "handle is required" }, 400);
		return json({
			results: await findByAuthor(env.db, handle, num(q.get("limit"), 20)),
		});
	},
};

const tagsRoute: Route = {
	method: "GET",
	path: "/api/tags",
	handle: async ({ env }) => json({ tags: await listTags(env.db) }),
};

/**
 * Bulk actions, set-shaped on purpose: selecting forty cards and issuing forty
 * round trips is how a bulk action becomes slow enough to abandon.
 */
const archiveRoute: Route = {
	method: "POST",
	path: "/api/items/archive",
	handle: async ({ env, request }) => {
		const body = (await request.json().catch(() => ({}))) as {
			ids?: string[];
			archived?: boolean;
		};
		if (!Array.isArray(body.ids))
			return json({ error: "expected { ids: [...] }" }, 400);
		return json({
			changed: await setArchived(env.db, body.ids, body.archived !== false),
		});
	},
};

const tagRoute: Route = {
	method: "POST",
	path: "/api/items/tag",
	handle: async ({ env, request }) => {
		const body = (await request.json().catch(() => ({}))) as {
			ids?: string[];
			label?: string;
		};
		if (!Array.isArray(body.ids) || !body.label) {
			return json({ error: "expected { ids: [...], label }" }, 400);
		}
		return json({ tagged: await tagItems(env.db, body.ids, body.label) });
	},
};

const sourcesRoute: Route = {
	method: "GET",
	path: "/api/sources",
	handle: async ({ env }) => {
		const now = Math.floor(Date.now() / 1000);
		const [health, off, extension] = await Promise.all([
			sourceHealth(env.db),
			disabledSources(env.db),
			extensionHealth(env.db, now),
		]);
		return json(sourceCatalogueResponse(health, off, extension));
	},
};

const toggleSourceRoute: Route = {
	method: "POST",
	path: /^\/api\/sources\/([\w-]+)$/,
	handle: async ({ env, request, params }) => {
		const body = (await request.json().catch(() => ({}))) as {
			enabled?: boolean;
		};
		const source = params[0] ?? "";
		if (!isToggleableSource(source))
			return json({ error: "source cannot be toggled" }, 400);
		await setSourceEnabled(env.db, source, body.enabled !== false);
		return json({ source, enabled: body.enabled !== false });
	},
};

const extensionHeartbeatRoute: Route = {
	method: "POST",
	path: "/api/extension/heartbeat",
	handle: async ({ env, request }) => {
		const denied = authorizeExtension(env, request);
		if (denied) return denied;
		const parsed = parseExtensionHeartbeat(
			await request.json().catch(() => null),
		);
		if (!parsed.ok) return json({ error: parsed.error.message }, 400);
		const receivedAt = Math.floor(Date.now() / 1000);
		await recordExtensionHeartbeat(env.db, parsed.heartbeat, receivedAt);
		return json({ ok: true, receivedAt });
	},
};

const creatorsRoute: Route = {
	method: "GET",
	path: "/api/creators",
	handle: async ({ env, q }) =>
		json({ creators: await creators(env.db, num(q.get("limit"), 100)) }),
};

const statsRoute: Route = {
	method: "GET",
	path: "/api/stats",
	handle: async ({ env }) => json(await libraryStats(env.db)),
};

/**
 * What the extension is told to do, per source.
 *
 * Data rather than code, because it is the thing most likely to change when a
 * platform moves an endpoint — and changing it here fixes every install on its
 * next run.
 */
const EXTENSION_SOURCES = [
	{
		// Paged: the extension can walk the whole history itself.
		mode: "page",
		source: "x",
		host: "x.com",
		operation: "Bookmarks",
		variables: { count: 100, includePromotedContent: false },
		cursorPrefix: "cursor-bottom",
		entryPrefix: "tweet-",
		pageLimit: 40,
		// Watched for real-time capture; unlike the timeline query this operation
		// IS in the main bundle.
		watchOperations: ["CreateBookmark", "DeleteBookmark"],
	},
	{
		// Also paged, but plain REST rather than GraphQL — no queryId to resolve,
		// and a documented cursor. `me` resolves from the session.
		mode: "page",
		source: "reddit",
		host: "reddit.com",
		url: "https://www.reddit.com/user/me/saved.json?limit=100&raw_json=1",
		cursorParam: "after",
		cursorPath: "data.after",
		pageLimit: 40,
		watchUrls: ["/api/save", "/api/unsave"],
	},
	{
		/**
		 * Observe-only, and the reason that mode exists.
		 *
		 * TikTok publishes no saved/favorites API, and its web requests are signed
		 * (X-Bogus, msToken) so they cannot be forged from outside the app. What
		 * can be done is watch what the app fetches while your own Favorites load
		 * — no forging, no signature work, and the payload is the same one the
		 * page renders from.
		 */
		mode: "observe",
		source: "tiktok",
		host: "tiktok.com",
		watchUrls: ["/api/user/collect/item_list"],
	},
	{
		// GitHub stars are rendered on a signed-in page. The extension reads only
		// bounded repository fields from that page and follows its normal pagination.
		mode: "page",
		source: "github",
		host: "github.com",
		url: "https://github.com/stars",
		pageLimit: 40,
		watchUrls: ["/star", "/unstar"],
	},
];

/**
 * The extension's instruction sheet.
 *
 * This is what makes shipping load-unpacked viable. The extension knows almost
 * nothing: it fetches this, does what it says, and uploads the raw result. When
 * X moves an endpoint you change this and the parser, and every install is
 * fixed on its next run regardless of when it was installed. The extension's
 * version stops mattering.
 *
 * It doubles as a kill switch: set enabled false and every install stops.
 */
const extensionConfigRoute: Route = {
	method: "GET",
	path: "/api/extension/config",
	handle: async ({ env, url }) => {
		// A switched-off source is simply absent from the config, so the extension
		// stops capturing it on its next run without an update.
		const off = new Set(await disabledSources(env.db));
		return json({
			version: 1,
			enabled: true,
			ingest: new URL("/api/ingest", url.origin).toString(),
			ingestProtocolVersion: 2,
			features: {
				/**
				 * One source at a time, and the flag moves the whole path.
				 *
				 * This is not a switch for unsaves — it decides who delivers
				 * everything for that source. With it on, X's timeline pages and its
				 * save/unsave events both go through the durable queue; with it off,
				 * pages take the legacy direct upload and item events are dropped
				 * because legacy has no way to express them. Exactly one path owns a
				 * capture, which is why this is staged per source rather than
				 * globally.
				 *
				 * x: enabled for acceptance testing. reddit and tiktok stay staged
				 * until each has been through the same pass.
				 */
				captureV2: {
					x: true,
					reddit: true,
					tiktok: false,
					github: true,
					// Web capture has no legacy path to conflict with — the durable
					// queue is the only way a saved page ever reaches here — so there is
					// nothing to stage.
					web: true,
				},
				// Mirroring is a per-install choice made in the popup, behind an
				// optional permission — this only says the build supports it.
				chromeBookmarks: true,
			},
			sources: EXTENSION_SOURCES.filter((s) => !off.has(s.source)),
		});
	},
};

/**
 * The extension's endpoint. Bearer auth rather than open, because an open
 * ingest on a public URL is an invitation to have someone else's library
 * merged into yours.
 */
const ingestRoute: Route = {
	method: "POST",
	path: "/api/ingest",
	handle: async ({ env, request }) => {
		const denied = authorizeExtension(env, request);
		if (denied) return denied;

		const result = await ingestCapture(env.db, request);

		/**
		 * Thumbnails, without making the upload wait for them.
		 *
		 * Anything ingested this way used to keep a media row with a null
		 * stored_key forever, because only the CLI ever fetched images — so a
		 * TikTok save rendered as a caption with no video. Fire-and-forget and
		 * bounded: an ingest must not block on image fetches, and a burst of saves
		 * must not become an unbounded download.
		 */
		if (env.media && result.syncMedia) {
			void fetchPendingMedia(env.db, env.media).catch(() => {});
		}

		return json(result.body, result.status);
	},
};

/**
 * Matched in order. `/api/items` has to be tried before `/api/items/:id` only
 * because the second is a pattern; everything else is disjoint.
 */
const ROUTES: Route[] = [
	mediaRoute,
	itemsRoute,
	itemRoute,
	searchRoute,
	recentRoute,
	authorsRoute,
	tagsRoute,
	archiveRoute,
	tagRoute,
	sourcesRoute,
	toggleSourceRoute,
	creatorsRoute,
	statsRoute,
	extensionConfigRoute,
	extensionHeartbeatRoute,
	ingestRoute,
];

/** An exact path matches with no captures; a pattern yields its groups. */
function paramsFor(pattern: string | RegExp, path: string): string[] | null {
	if (typeof pattern === "string") return pattern === path ? [] : null;
	const match = pattern.exec(path);
	return match ? match.slice(1).map((value) => value ?? "") : null;
}

export async function handleApi(
	env: ApiEnv,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "");

	for (const route of ROUTES) {
		if (route.method !== request.method) continue;
		const params = paramsFor(route.path, path);
		if (!params) continue;
		return await route.handle({
			env,
			request,
			url,
			q: url.searchParams,
			params,
		});
	}

	return json({ error: "not found" }, 404);
}
