import { sql as trailSql } from "drizzle-orm";
import { coordinateSearch } from "./search-coordinator.ts";
import { sql } from "drizzle-orm";
import { runPreviewPass } from "./link-preview.ts";
import { setClientWrite, retireSelf, authorizeClient, createClient, listClients, retired, retireLegacy, updateClient, redeemPairing } from "./clients.ts";
import { checkPublicGithub } from "./public-github-sync.ts";
import { decideRequest, describeRequest, exchangeToken, registerClient, type AuthorizationParams } from "./oauth.ts";
import {
	creatorPage,
	extensionHealth,
	knownSyncIds, getSyncSettings, setSyncSettings, pendingPlatformSync, requestPlatformSync,
	latestLibrarySyncRequest,
	requestLibrarySync,
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
	setItemNote, setFavorite, removeItemTag, listCollections, saveCollection, deleteCollection, exportLibrary,
	InvalidListCursorError, InvalidSearchCursorError, InvalidCreatorCursorError,
	getLibraryRestore,
  getAiSettings, setAiSettings, aiProgress, reclassifyAiTopics, TOPIC_TAXONOMY_VERSION,
  clearSemanticIndex, estimateSemanticBackfill, semanticIndexStats,
} from "@anansi/db";
import type { AnansiDb, SearchOptions } from "@anansi/db";
import { authorizeLibrary, sessionRoute, type LibraryAuthEnv } from "./library-auth.ts";
import {
	EXTENSION_PLATFORM_SOURCES,
	parseExtensionHeartbeat,
	type ExtensionPlatformSource,
	type ExtensionSourceConfig,
} from "@anansi/sources";
import { fetchPendingMedia, readMedia, type MediaSource } from "./media.ts";
import type { AiBinding, VectorizeBinding } from "./ai.ts";
import { createVectorIndex } from "./ai.ts";
import { drainSemanticVectorDeletes } from "./semantic-vector-cleanup.ts";
import { ingestCapture } from "./ingest.ts";
import { handleRestoreRequest } from "./restore.ts";
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

export interface ApiEnv extends LibraryAuthEnv {
	waitUntil?: (promise: Promise<unknown>) => void;
	db: AnansiDb;
	media?: MediaSource;
	ai?: AiBinding;
	vectorize?: VectorizeBinding;
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
	method: "GET" | "POST" | "PATCH" | "DELETE";
	/** An exact path, or a pattern whose captures become `params`. */
	path: string | RegExp;
	handle: (ctx: Ctx) => Response | Promise<Response>;
}

const authorizeExtension = authorizeClient;

/* --------------------------------------------------------- handlers --- */

// Served from our own copy, never hot-linked: a deleted post still renders,
// and no request from the library tells the platform what you are reading.
const mediaRoute: Route = {
	method: "GET",
	path: /^\/api\/media\/(.+)$/,
	handle: ({ env, params }) =>
		readMedia(env.media ?? {}, decodeURIComponent(params[0] ?? "")),
};

async function previewState<T extends {items: {id:string;source:string}[]}>(db: AnansiDb, page: T) {
  const ids = page.items.filter(item=>item.source === "web").map(item=>item.id);
  const attempted = ids.length ? await db.all<{item_id:string}>(sql`SELECT item_id FROM link_preview_jobs WHERE attempts>0 AND item_id IN (${sql.join(ids.map(id=>sql`${id}`),sql`,` )})`) : [];
  const seen = new Set(attempted.map(row=>row.item_id));
  return {...page,items:page.items.map(item=>({...item,previewAttempted:seen.has(item.id)}))};
}
const itemsRoute: Route = {
	method: "GET",
	path: "/api/items",
	handle: async ({ env, q }) => {
		try {
			return json(
				await previewState(env.db, await listItems(env.db, {
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
					favorite: q.get("favorite") === "1" ? true : undefined,
					nsfw: q.get("nsfw") === "1" ? true : undefined,
					removed: (["exclude", "only"] as const).find(
						(v) => v === q.get("removed"),
					),
					order: q.get("order") === "posted" ? "posted" : "saved",
					limit: num(q.get("limit"), 50),
				})),
			);
		} catch (error) {
			if (error instanceof InvalidListCursorError || error instanceof InvalidSearchCursorError)
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
		if (!found) return json({ error: "not found" }, 404);
    const events = await env.db.all<{ observedAt: number; receivedAt: number; outcome: string }>(trailSql`select observed_at as observedAt, received_at as receivedAt, outcome from capture_events where item_id = ${found.id} order by received_at desc limit 1`);
    const jobs = await env.db.all<{ status: string; lastError: string | null }>(trailSql`select status, last_error as lastError from ai_enrichment_jobs where item_id = ${found.id} and kind = 'tagging' order by updated_at desc limit 1`);
    return json({ ...found, captureTrail: events[0] ?? null, taggingState: jobs[0] ?? null });
	},
};

const searchRoute: Route = {
	method: "GET",
	path: "/api/search",
	handle: async ({ env, q }) => {
		const query = q.get("q") ?? "";
		if (!query.trim()) return json({ error: "q is required" }, 400);
        try {
          const searchOptions: SearchOptions = {
            query, source: q.getAll("source"), author: q.getAll("author"), tag: q.getAll("tag"),
            media: q.get("media") ?? undefined, contentType: q.getAll("type"),
            archived: q.get("archived") === "1", favorite: q.get("favorite") === "1" ? true : undefined,
            nsfw: q.get("nsfw") === "1" ? true : undefined,
            removed: (["exclude", "only"] as const).find(v => v === q.get("removed")),
            order: q.get("order") === "posted" ? "posted" : "saved", cursor: q.get("cursor") ?? undefined,
            limit: num(q.get("limit"), 50),
          };
          const hybrid = await coordinateSearch(env, searchOptions);
          const enriched = await previewState(env.db, hybrid);
          return json({ query, items: enriched.items, results: enriched.items, nextCursor: hybrid.nextCursor, semantic: hybrid.semantic });
        } catch (error) {
          if (error instanceof InvalidListCursorError || error instanceof InvalidSearchCursorError) return json({ error: error.message }, 400);
          throw error;
        }
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
		const denied = await authorizeExtension(env, request);
		if (denied) return denied;
		const parsed = parseExtensionHeartbeat(
			await request.json().catch(() => null),
		);
		if (!parsed.ok) return json({ error: parsed.error.message }, 400);
		const receivedAt = Math.floor(Date.now() / 1000);
		await recordExtensionHeartbeat(env.db, parsed.heartbeat, receivedAt);
		return json({
			ok: true,
			receivedAt,
			syncRequestedAt: await latestLibrarySyncRequest(env.db),
      platformSync: await pendingPlatformSync(env.db),
		});
	},
};

/** A library page opened somewhere. The extension acts on this at check-in. */
const librarySyncRoute: Route = {
	method: "POST",
	path: "/api/sync",
	handle: async ({ env, request }) => {
    const body = (request.body === null ? {} : await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || (body.force !== undefined && typeof body.force !== "boolean")) return json({error: "invalid sync request"}, 400);
		const requestedAt = Math.floor(Date.now() / 1000);
		await requestLibrarySync(env.db, requestedAt);
    if (body.browserHandled !== true) await requestPlatformSync(env.db, requestedAt, body.force === true ? "force" : "library");
    const github = checkPublicGithub(env.db, fetch, requestedAt, body.force === true);
    if (env.waitUntil) env.waitUntil(github); else await github;
		return json({ requestedAt });
	},
};

const creatorsRoute: Route = {
	method: "GET",
	path: "/api/creators",
	handle: async ({ env, q }) => {
		try {
			return json(await creatorPage(env.db, {
				query: q.get("q") ?? "",
				source: q.getAll("source"),
				cursor: q.get("cursor") ?? undefined,
				limit: num(q.get("limit"), 40),
			}));
		} catch (error) {
			if (error instanceof InvalidCreatorCursorError) return json({ error: error.message }, 400);
			throw error;
		}
	},
};

const extensionStatsRoute: Route = {
  method: "GET", path: "/api/extension/stats",
  handle: async ({env}) => { const stats = await libraryStats(env.db); return json({items:stats.items,bySource:stats.bySource}); },
};

const statsRoute: Route = {
	method: "GET",
	path: "/api/stats",
	handle: async ({ env }) => {
    if (env.media && env.waitUntil) env.waitUntil(runPreviewPass(env.db, env.media));
    return json(await libraryStats(env.db));
  },
};

const aiSettingsRoute: Route = {
  method: "GET",
  path: "/api/ai",
  handle: async ({ env }) => {
    const settings = await getAiSettings(env.db);
    return json({
      settings,
      taxonomyVersion: TOPIC_TAXONOMY_VERSION,
      progress: await aiProgress(env.db),
      embeddingProgress: await aiProgress(env.db, "embedding", settings.embeddingModel),
      taggingProgress: await aiProgress(env.db, "tagging", settings.tagModel),
      semanticIndex: await semanticIndexStats(env.db, settings.embeddingModel, settings.semanticGeneration),
      available: Boolean(env.ai),
      capabilities: {
        semanticSearch: Boolean(env.ai && env.vectorize),
        autoTagging: Boolean(env.ai),
      },
      runtime: env.ai ? "cloudflare" : "none",
    });
  },
};

const semanticPreviewRoute: Route = {
	method: "GET",
	path: "/api/ai/semantic-preview",
	handle: async ({ env }) => {
		if (!(env.ai && env.vectorize)) return json({ error: "semantic search is unavailable in this environment" }, 503);
		const settings = await getAiSettings(env.db);
		const estimate = await estimateSemanticBackfill(env.db, settings.embeddingModel);
		const remainingCredits = Math.max(0, settings.semanticBudgetLimit - settings.semanticBudgetUsed);
		return json({ estimate, credits: { used: settings.semanticBudgetUsed, limit: settings.semanticBudgetLimit, remaining: remainingCredits, month: settings.semanticBudgetMonth }, runtime: "cloudflare" });
	},
};

const aiReclassifyRoute: Route = {
  method: "POST",
  path: "/api/ai/reclassify",
  handle: async ({ env }) => {
    const settings = await getAiSettings(env.db);
    const taggingProgress = await aiProgress(env.db, "tagging", settings.tagModel);
    if (settings.autoTaggingEnabled === 1 && taggingProgress.pending > 0) {
      return json({
        taxonomyVersion: TOPIC_TAXONOMY_VERSION,
        progress: await aiProgress(env.db),
        taggingProgress,
      });
    }
    await reclassifyAiTopics(env.db);
    return json({
      taxonomyVersion: TOPIC_TAXONOMY_VERSION,
      progress: await aiProgress(env.db),
      embeddingProgress: await aiProgress(env.db, "embedding", settings.embeddingModel),
      taggingProgress: await aiProgress(env.db, "tagging", settings.tagModel),
    });
  },
};

const aiSettingsUpdateRoute: Route = {
  method: "PATCH",
  path: "/api/ai",
  handle: async ({ env, request }) => {
    const body = await request.json().catch(() => null) as { semanticSearchEnabled?: unknown; semanticIndexPaused?: unknown; semanticBudgetLimit?: unknown; confirmSemanticBackfill?: unknown; autoTaggingEnabled?: unknown } | null;
    if (!body || (body.semanticSearchEnabled !== undefined && typeof body.semanticSearchEnabled !== "boolean") || (body.semanticIndexPaused !== undefined && typeof body.semanticIndexPaused !== "boolean") || (body.semanticBudgetLimit !== undefined && (!Number.isInteger(body.semanticBudgetLimit) || (body.semanticBudgetLimit as number) < 1 || (body.semanticBudgetLimit as number) > 1_000_000)) || (body.confirmSemanticBackfill !== undefined && typeof body.confirmSemanticBackfill !== "boolean") || (body.autoTaggingEnabled !== undefined && typeof body.autoTaggingEnabled !== "boolean")) return json({ error: "invalid AI settings" }, 400);
    const current = await getAiSettings(env.db);
    const enablingSemantic = body.semanticSearchEnabled === true && current.semanticSearchEnabled !== 1;
    if (enablingSemantic) {
      if (!(env.ai && env.vectorize)) return json({ error: "semantic search is unavailable in this environment" }, 503);
      if (body.confirmSemanticBackfill !== true) return json({ error: "review and confirm the semantic indexing estimate first" }, 409);
      const estimate = await estimateSemanticBackfill(env.db, current.embeddingModel);
      const limit = (body.semanticBudgetLimit as number | undefined) ?? current.semanticBudgetLimit;
      const remaining = Math.max(0, limit - current.semanticBudgetUsed);
      if (estimate.estimatedCredits > remaining) return json({ error: `backfill needs ${estimate.estimatedCredits} app credits but only ${remaining} remain; raise the monthly limit or wait for the monthly reset`, estimate, remainingCredits: remaining }, 409);
    }
    const disablingSemantic = body.semanticSearchEnabled === false && current.semanticSearchEnabled === 1;
    const settings = await setAiSettings(env.db, {
      semanticSearchEnabled: body.semanticSearchEnabled as boolean | undefined,
      semanticIndexPaused: body.semanticIndexPaused as boolean | undefined,
      semanticBudgetLimit: body.semanticBudgetLimit as number | undefined,
      autoTaggingEnabled: body.autoTaggingEnabled as boolean | undefined,
    });
    if (disablingSemantic) {
      await clearSemanticIndex(env.db);
      const index = env.vectorize ? createVectorIndex(env.vectorize, current.embeddingDimensions) : undefined;
      await drainSemanticVectorDeletes(env.db, index, 100);
    }
    return json({
      settings,
      taxonomyVersion: TOPIC_TAXONOMY_VERSION,
      progress: await aiProgress(env.db),
      embeddingProgress: await aiProgress(env.db, "embedding", settings.embeddingModel),
      taggingProgress: await aiProgress(env.db, "tagging", settings.tagModel),
      semanticIndex: await semanticIndexStats(env.db, settings.embeddingModel, settings.semanticGeneration),
    });
  },
};

/**
 * What the extension is told to do, per source.
 *
 * Data rather than code, because it is the thing most likely to change when a
 * platform moves an endpoint — and changing it here fixes every install on its
 * next run.
 */
const EXTENSION_SOURCE_DETAILS: Record<
	ExtensionPlatformSource,
	Omit<ExtensionSourceConfig, "source">
> = {
	x: {
		// Extension wire mode "page" drives a page/history walk. The product
		// catalogue's mode comes from the canonical capability importMode.
		mode: "page",
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
	reddit: {
		// Wire mode "page" means a background request, not the product
		// catalogue's session import mode. Reddit's `me` and cursor resolve from
		// the signed-in session.
		mode: "page",
		host: "reddit.com",
		url: "https://www.reddit.com/user/me/saved.json?limit=100&raw_json=1",
		cursorParam: "after",
		cursorPath: "data.after",
		pageLimit: 40,
		watchUrls: ["/api/save", "/api/unsave"],
	},
	github: {
		// Wire mode "page" means the extension reads a signed-in page. The
		// product catalogue still describes GitHub history as session import.
		mode: "page",
		host: "github.com",
		url: "https://github.com/stars",
		pageLimit: 40,
		watchUrls: ["/star", "/unstar"],
	},
	tiktok: {
		mode: "observe",
		host: "tiktok.com",
		watchUrls: ["/api/user/collect/item_list"],
		mutationUrl: "/api/item/collect/",
		idField: "itemId",
		actionField: "action",
		savedValue: "1",
		unsavedValue: "2",
	},
};

const EXTENSION_SOURCES: readonly ExtensionSourceConfig[] =
	EXTENSION_PLATFORM_SOURCES.map((source) => ({
		source,
		...EXTENSION_SOURCE_DETAILS[source],
	}));

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
					 * x: enabled for acceptance testing. reddit stays staged
				 * until each has been through the same pass.
				 */
				captureV2: {
					x: true,
					reddit: true,
					github: true,
					tiktok: true,
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
		const denied = await authorizeExtension(env, request);
		if (denied) return denied;

		const result = await ingestCapture(env.db, request);

		/**
		 * Thumbnails, without making the upload wait for them.
		 *
		 * Anything ingested this way used to keep a media row with a null
		 * stored_key forever, because only the CLI ever fetched images — so a
		 * A save rendered as a caption with no media. Fire-and-forget and bounded:
		 * an ingest must not block on image fetches, and a burst of saves
		 * must not become an unbounded download.
		 */
		if (env.media && result.status < 300 && (result.syncMedia || env.waitUntil)) {
			const work = runPreviewPass(env.db, env.media);
			if (env.waitUntil) env.waitUntil(work); else await work;
		}

		return json(result.body, result.status);
	},
};

const itemUpdateRoute: Route = {
  method: "PATCH", path: /^\/api\/items\/([\w-]+)$/,
  handle: async ({env, request, params}) => {
    const id = params[0]!;
    if (!(await getItem(env.db, id))) return json({error:"not found"},404);
    const body = await request.json().catch(() => null) as {note?:unknown;favorite?:unknown;archived?:unknown} | null;
    if (!body || (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 20000)) || (body.favorite !== undefined && typeof body.favorite !== "boolean") || (body.archived !== undefined && typeof body.archived !== "boolean")) return json({error:"invalid item update"},400);
    if (typeof body.note === "string") await setItemNote(env.db,id,body.note);
    if (typeof body.favorite === "boolean") await setFavorite(env.db,[id],body.favorite);
    if (typeof body.archived === "boolean") await setArchived(env.db,[id],body.archived);
    return json(await getItem(env.db,id));
  }
};
const itemTagsRoute = (method: "POST" | "DELETE"): Route => ({
  method, path: /^\/api\/items\/([\w-]+)\/tags$/,
  handle: async ({env, request, params}) => {
    if (!(await getItem(env.db,params[0]!))) return json({error:"not found"},404);
    const body = await request.json().catch(() => null) as {label?:unknown} | null;
    if (!body || typeof body.label !== "string" || !body.label.trim() || body.label.length > 100) return json({error:"invalid tag"},400);
    if (method === "POST") await tagItems(env.db,[params[0]!],body.label);
    else await removeItemTag(env.db,params[0]!,body.label);
    return json({ok:true});
  }
});
const collectionRoutes: Route[] = [
  {method:"GET",path:"/api/collections",handle:async({env})=>json({collections:await listCollections(env.db)})},
  {method:"POST",path:"/api/collections",handle:async({env,request})=>{
    const body=await request.json().catch(()=>null) as Parameters<typeof saveCollection>[1] | null;
    if (!body || typeof body.name!=="string" || !body.name.trim() || body.name.length>100 || typeof body.filters!=="object" || !body.filters || Array.isArray(body.filters)) return json({error:"invalid collection"},400);
    try { return json({collection:await saveCollection(env.db,body)}); } catch { return json({error:"invalid collection"},400); }
  }},
  {method:"DELETE",path:/^\/api\/collections\/([\w-]+)$/,handle:async({env,params})=>{await deleteCollection(env.db,params[0]!);return json({deleted:true});}},
  {method:"GET",path:"/api/export",handle:async({env})=>new Response(JSON.stringify(await exportLibrary(env.db)),{headers:{"content-type":"application/json; charset=utf-8","content-disposition":'attachment; filename="anansi-library.json"',"cache-control":"no-store"}})},
  {method:"POST",path:"/api/media/retry",handle:async({env})=>env.media ? json(await fetchPendingMedia(env.db,env.media)) : json({error:"media is not configured"},503)},
];

/**
 * Matched in order. `/api/items` has to be tried before `/api/items/:id` only
 * because the second is a pattern; everything else is disjoint.
 */
export const ROUTES: Route[] = [
  {method:"POST", path:"/api/link-previews/visible", handle:async({env,request})=>{
    const body = await request.json().catch(()=>null) as {ids?: unknown} | null;
    if (!Array.isArray(body?.ids) || body.ids.length > 12 || body.ids.some((id: unknown)=>typeof id !== "string" || id.length > 100)) return json({error:"expected up to 12 item ids"},400);
    const ids = [...new Set<string>(body.ids)];
    if (!ids.length) return json({subrequests:0});
    if (!env.media) return json({error:"media is not configured"},503);
    return json(await runPreviewPass(env.db,env.media,ids));
  }},
	...(["/api/restore/start", "/api/restore/chunk", "/api/restore/finish", "/api/restore/abort"] as const).map((path): Route => ({ method: "POST", path, handle: ({ env, request }) => handleRestoreRequest(env, request) })),
	{ method: "GET", path: "/api/restore", handle: ({ env, request }) => handleRestoreRequest(env, request) },
	itemUpdateRoute, itemTagsRoute("POST"), itemTagsRoute("DELETE"), ...collectionRoutes,
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
	statsRoute, extensionStatsRoute,
	aiSettingsRoute, semanticPreviewRoute, aiSettingsUpdateRoute, aiReclassifyRoute,
	extensionConfigRoute,
	extensionHeartbeatRoute,
	librarySyncRoute,
  {method: "GET", path: "/api/sync/settings", handle: async ({env}) => json(await getSyncSettings(env.db))},
  {method: "POST", path: "/api/sync/settings", handle: async ({env, request}) => {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.agentTabs !== "boolean" || !(body.githubUsername === null || typeof body.githubUsername === "string")) return json({error: "invalid settings"},400);
    try { await setSyncSettings(env.db, {agentTabs: body.agentTabs, githubUsername: body.githubUsername}); } catch { return json({error: "invalid GitHub username"},400); }
    return json(await getSyncSettings(env.db));
  }},
  { method: "GET", path: "/api/extension/known-ids", handle: async ({env, q}) => {
    const source = q.get("source");
    if (!source || !["x", "reddit", "github", "tiktok"].includes(source)) return json({error: "invalid source"}, 400);
    return json({ ids: await knownSyncIds(env.db, source) });
  } },
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

  if (path === "/api/auth/session") return sessionRoute(env, request);
  // Public by design: an app has no credential yet when it registers or trades a code.
  if (path === "/api/oauth/register" && request.method === "POST") return registerClient(env.db, request);
  if (path === "/api/oauth/token" && request.method === "POST") return exchangeToken(env.db, request);
  if (path === "/api/oauth/authorize") {
    // Approving an app needs the owner's signed-in browser session, never a bearer.
    if (request.headers.has("authorization")) return json({error:"Use owner sign-in"},401);
    const denied = authorizeLibrary(env, request);
    if (denied) return denied;
    if (request.method === "GET") return json(await describeRequest(env.db, url.origin, Object.fromEntries(url.searchParams) as AuthorizationParams));
    if (request.method !== "POST") return json({error:"method not allowed"},405);
    if (request.headers.get("origin") !== url.origin) return json({error:"origin is not allowed"},403);
    const body = await request.json().catch(() => null) as {params?: AuthorizationParams; allow?: unknown} | null;
    if (!body?.params || typeof body.allow !== "boolean") return json({error:"invalid request"},400);
    return decideRequest(env.db, url.origin, body.params, body.allow);
  }
  if (path === "/api/connect/redeem" && request.method === "POST") {
    // Browsers send the extension's own Origin on this POST. Web pages cannot claim that scheme.
    const origin = request.headers.get("origin");
    if (origin && !/^(chrome|moz)-extension:[/][/][a-z0-9-]+$/i.test(origin)) return json({error:"extension context required"},403);
    const body = await request.json().catch(()=>null) as {code?: unknown} | null;
    const result = typeof body?.code === "string" && body.code.length < 100 ? await redeemPairing(env.db,body.code) : null;
    return Response.json(result ?? {error:"Invalid or expired code"},{status:result ? 200 : 401,headers:{"cache-control":"no-store"}});
  }
  if (path === "/api/extension/retire-self" && request.method === "POST") {
    return await retireSelf(env.db,request) ? json({ok:true}) : json({error:"unauthorized"},401);
  }
  if (path === "/api/clients" || path.startsWith("/api/clients/")) {
    if (path.endsWith("/permissions")) {
      if (request.headers.has("authorization")) return json({error:"Use owner session"},401);
      const denied = authorizeLibrary(env,request); if (denied) return denied;
      if (request.headers.get("origin") !== url.origin) return json({error:"origin is not allowed"},403);
      if (request.method !== "PATCH") return json({error:"method not allowed"},405);
      const body = await request.json().catch(()=>null) as {write?:unknown}|null;
      if (typeof body?.write !== "boolean") return json({error:"write must be boolean"},400);
      const client = await setClientWrite(env.db,path.slice(13,-12),body.write);
      return client ? json({client}) : json({error:"eligible client not found"},404);
    }
    if (request.headers.has("authorization") && await retired(env.db)) return json({error:"Use owner sign-in"},401);
    const denied=authorizeLibrary(env,request); if (denied) return denied;
    // Management always requires same-origin, even for explicit owner bearer requests.
    if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return json({error:"origin is not allowed"},403);
    let result: unknown;
    try {
      if (request.method === "GET" && path === "/api/clients") result={clients:await listClients(env.db),legacyActive:!await retired(env.db)};
      else if (request.method === "POST" && path === "/api/clients/retire-legacy") { await retireLegacy(env.db); result={ok:true}; }
      else if (request.method === "POST" && path === "/api/clients") {
        const body=await request.json() as {scopes?:unknown;kind: "api"|"extension"|"pairing";name:string};
        if (body.scopes !== undefined || !["api","extension","pairing"].includes(body.kind)) return json({error:"Invalid permissions or kind"},400);
        result=await createClient(env.db,body.name,body.kind);
      } else if (["PATCH","DELETE"].includes(request.method) && path.startsWith("/api/clients/")) {
        const name=request.method === "PATCH" ? (await request.json() as {name?:unknown}).name : undefined;
        if (request.method === "PATCH" && typeof name !== "string") return json({error:"Invalid name"},400);
        await updateClient(env.db,path.slice("/api/clients/".length),typeof name === "string" ? name : undefined); result={ok:true};
      } else return json({error:"not found"},404);
    } catch { return json({error:"Invalid client request"},400); }
    return Response.json(result,{headers:{"cache-control":"no-store"}});
  }
  if (request.headers.has("authorization") && !path.startsWith("/api/extension/") && path !== "/api/ingest" && await retired(env.db)) return json({error:"Use owner sign-in"},401);
  const isExtension = path === "/api/ingest" || path.startsWith("/api/extension/");
  const denied = isExtension ? await authorizeExtension(env, request) : authorizeLibrary(env, request);
  if (denied) return denied;
	if (request.method !== "GET" && !path.startsWith("/api/restore/")) {
		const restore = await getLibraryRestore(env.db);
		if (restore?.status === "active") return json({ error: "Library restore is in progress" }, 409);
	}

	for (const route of ROUTES) {
		if (route.method !== request.method) continue;
		const params = paramsFor(route.path, path);
		if (!params) continue;
		const response = await route.handle({
			env,
			request,
			url,
			q: url.searchParams,
			params,
		});
		response.headers.set("cache-control", "private, no-store");
		response.headers.set("x-content-type-options", "nosniff");
		return response;
	}

	return json({ error: "not found" }, 404);
}
