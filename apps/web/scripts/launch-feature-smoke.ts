/**
 * Synthetic launch acceptance over the current web API and MCP transport.
 *
 * Run from the repository root with:
 *   bun apps/web/scripts/launch-feature-smoke.ts
 *
 * This script owns a migrated in-memory SQLite database and uses synthetic
 * content. It does not read the personal library path, call providers, or use
 * a Cloudflare account. Browser and live-provider evidence remain separate.
 */
import { createHash, createHmac } from "node:crypto";
import {
	schema,
	type AnansiDb,
	type LibraryExport,
	RESTORE_TABLES,
	restoreCounts,
} from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { validateRestoreBackup } from "@anansi/db/restore-preflight";
import { type ApiEnv, handleApi } from "../src/server/api.ts";
import { handleMcp, type McpEnv } from "../src/server/mcp.ts";

const ORIGIN = "https://anansi-smoke.invalid";
const LIBRARY_TOKEN = "launch-smoke-library-token";
const INGEST_TOKEN = "launch-smoke-ingest-token";
const MCP_TOKEN = "launch-smoke-mcp-token";
const SAVED_AT = 1_800_000_000;
const PAGE_SIZE = 30;

type CheckStatus = "passed" | "failed" | "blocked";
type Check = {
	id: string;
	status: CheckStatus;
	evidence?: unknown;
	error?: string;
};

const checks: Check[] = [];
const failures: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

async function check(
	id: string,
	run: () => Promise<unknown> | unknown,
): Promise<void> {
	try {
		const evidence = await run();
		checks.push({ id, status: "passed", evidence });
	} catch (error) {
		const message = safeError(error);
		checks.push({ id, status: "failed", error: message });
		failures.push(id);
	}
}

function blocked(id: string, reason: string): void {
	checks.push({ id, status: "blocked", error: reason });
}

async function bodyJson(response: Response): Promise<any> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { rawText: text.slice(0, 240) };
	}
}

function jsonHeaders(headers?: HeadersInit): Headers {
	const result = new Headers(headers);
	result.set("content-type", "application/json");
	return result;
}

function request(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		authorization?: "library" | "extension" | "none";
		token?: string;
		headers?: HeadersInit;
	} = {},
): Request {
	const method = options.method ?? "GET";
	const headers = jsonHeaders(options.headers);
	if (options.authorization === "library") {
		headers.set("authorization", `Bearer ${options.token ?? LIBRARY_TOKEN}`);
	} else if (options.authorization === "extension") {
		headers.set("authorization", `Bearer ${options.token ?? INGEST_TOKEN}`);
	}
	const body =
		options.body === undefined ? undefined : JSON.stringify(options.body);
	return new Request(new URL(path, ORIGIN), { method, headers, body });
}

function api(
	env: ApiEnv,
	path: string,
	options: Parameters<typeof request>[1] = { authorization: "library" },
): Promise<Response> {
	return handleApi(
		env,
		request(path, { authorization: "library", ...options }),
	);
}

function equal(actual: unknown, expected: unknown, message: string): void {
	assert(
		actual === expected,
		`${message}: expected ${String(expected)}, received ${String(actual)}`,
	);
}

function includes(values: unknown, expected: unknown, message: string): void {
	assert(Array.isArray(values) && values.includes(expected), message);
}

function parseDataLine(text: string): unknown {
	const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const payload = lines[index]!.slice(5).trim();
		try {
			return JSON.parse(payload);
		} catch {
			// A stream can include non-JSON data frames; try the prior frame.
		}
	}
	throw new Error("MCP response contained no JSON data frame");
}

let rpcId = 0;
async function rpc(
	env: McpEnv,
	method: string,
	params?: unknown,
	token = MCP_TOKEN,
): Promise<{ status: number; value: any }> {
	const response = await handleMcp(
		env,
		new Request(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
		}),
	);
	const text = await response.text();
	let value: any;
	if (text.includes("data:")) value = parseDataLine(text);
	else {
		try {
			value = JSON.parse(text);
		} catch {
			value = { rawText: text.slice(0, 240) };
		}
	}
	return { status: response.status, value };
}

function mcpPayload(value: any): any {
	const text = value?.result?.content?.find(
		(entry: any) => entry.type === "text",
	)?.text;
	if (typeof text !== "string")
		throw new Error("MCP tool returned no text payload");
	return JSON.parse(text);
}

function normalizedWeb(index: number) {
	const kind = (["article", "post", "repo", "video", "comment"] as const)[
		index % 5
	]!;
	return {
		source: "web",
		externalId: `launch-smoke-web-${String(index).padStart(2, "0")}`,
		url: `https://example.invalid/smoke/${index}`,
		kind,
		authorHandle: `launch-author-${String(index).padStart(2, "0")}`,
		authorName: `Launch Author ${String(index).padStart(2, "0")}`,
		title: `Synthetic launch fixture ${index}`,
		body:
			index === 0
				? "quasar recipe launch smoke searchable phrase"
				: `launch smoke fixture ${index} for local feature acceptance`,
		lang: "en",
		postedAt: SAVED_AT - 100 - index,
		savedAt: SAVED_AT - index,
		savedAtIsExact: true,
		saveOrder: 1_800_000_000_000 + index,
		metrics: { views: index },
		media:
			index === 1
				? [
						{
							kind: "image",
							originUrl: "https://cdn.example.invalid/smoke.png",
							width: 320,
							height: 200,
						},
					]
				: [],
		links: [`https://example.invalid/reference/${index}`],
		nsfw: index === 2,
		raw: { fixture: "launch-feature-smoke", index },
	};
}

function normalizedX() {
	return {
		source: "x",
		externalId: "launch-smoke-x-post",
		url: "https://x.com/smoke-author/status/launch-smoke-x-post",
		kind: "post",
		authorHandle: "launch-smoke-author",
		authorName: "Launch Smoke Author",
		title: "Synthetic native capture",
		body: "native bookmark capture with searchable texture wording",
		postedAt: SAVED_AT - 500,
		savedAt: SAVED_AT,
		savedAtIsExact: true,
		saveOrder: 1_800_000_000_100,
		metrics: { likes: 7 },
		media: [
			{
				kind: "image",
				originUrl: "https://cdn.example.invalid/native.png",
				width: 640,
				height: 480,
			},
		],
		links: ["https://example.invalid/native-link"],
		raw: { fixture: "launch-feature-smoke", source: "x" },
	};
}

function nativeEvent(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		payloadType: "item_event",
		eventId: "launch-smoke-x-save",
		source: "x",
		action: "save",
		externalId: "launch-smoke-x-post",
		canonicalUrl: "https://x.com/smoke-author/status/launch-smoke-x-post",
		observedAt: SAVED_AT,
		captureMethod: "platform_event",
		normalizedItem: normalizedX(),
		...overrides,
	};
}

function redditRawPage() {
	return {
		schemaVersion: 1,
		payloadType: "raw_page",
		eventId: "launch-smoke-reddit-run:page:1",
		source: "reddit",
		action: "snapshot",
		observedAt: SAVED_AT + 1,
		captureMethod: "platform_import",
		runId: "launch-smoke-reddit-run",
		page: 1,
		raw: {
			kind: "Listing",
			data: {
				after: null,
				children: [
					{
						kind: "t3",
						data: {
							id: "launch-smoke-reddit-post",
							name: "t3_launch-smoke-reddit-post",
							title: "Synthetic imported Reddit save",
							selftext: "This saved listing is a local synthetic fixture.",
							permalink:
								"/r/selfhosted/comments/launch-smoke-reddit-post/fixture/",
							subreddit: "selfhosted",
							author: "launch-import-author",
							created_utc: SAVED_AT - 600,
							score: 11,
							num_comments: 2,
						},
					},
				],
			},
		},
	};
}

function rawPageCapture(
	source: "x" | "github" | "tiktok",
	eventId: string,
	raw: unknown,
) {
	return {
		schemaVersion: 1,
		payloadType: "raw_page",
		eventId,
		source,
		action: "snapshot",
		observedAt: SAVED_AT + 4,
		captureMethod: "platform_import",
		runId: `${eventId}:run`,
		page: 1,
		raw,
	};
}

function xRawPage() {
	return {
		data: {
			bookmark_timeline_v2: {
				timeline: {
					instructions: [{
						entries: [{
							entryId: "tweet-launch-smoke-x-import",
							sortIndex: "1800000000000",
							content: {
								itemContent: {
									tweet_results: {
										result: {
											rest_id: "launch-smoke-x-import-post",
											core: {
											user_results: {
												result: {
													core: { screen_name: "launch-import-x", name: "Launch Import X" },
												},
											},
											legacy: {
												full_text: "Synthetic X bookmark page parser fixture",
												id_str: "launch-smoke-x-import-post",
												created_at: "2026-01-01T00:00:00.000Z",
											},
										},
									},
								},
							},
						},
						}],
					}],
				},
			},
		},
	};
}

function githubRawPage() {
	return {
		schemaVersion: 1,
		pageType: "github_stars",
		repositories: [{
			identity: "launch-smoke/repository",
			fullName: "launch-smoke/repository",
			owner: "launch-smoke",
			name: "repository",
			url: "https://github.com/launch-smoke/repository",
			description: "Synthetic starred repository parser fixture",
			language: "TypeScript",
			stars: 3,
			forks: 1,
		}],
	};
}

function tiktokRawPage() {
	return {
		itemList: [{
			id: "launch-smoke-tiktok-video",
			desc: "Synthetic TikTok page parser fixture",
			createTime: SAVED_AT - 700,
			author: { uniqueId: "launch-import-creator", nickname: "Launch Import Creator" },
			video: { cover: "https://cdn.example.invalid/tiktok-cover.jpg" },
			stats: { diggCount: 4, commentCount: 2, shareCount: 1, playCount: 80 },
		}],
	};
}

async function main(): Promise<void> {
	const local = openLocalDb(":memory:");
	const closeables: Array<{ close?: () => void }> = [];
	closeables.push(
		(local as unknown as { $client?: { close?: () => void } }).$client ?? {},
	);
	migrateLocalDb(local);
	const db = local as unknown as AnansiDb;
	const env: ApiEnv = {
		db,
		libraryToken: LIBRARY_TOKEN,
		ingestToken: INGEST_TOKEN,
	};
	const mcpEnv: McpEnv = { db, token: MCP_TOKEN };
	let sessionCookie: string | undefined;
	let nativeItemId: string | undefined;
	let webItemId: string | undefined;

	try {
		await check(
			"auth.library_and_extension_reject_missing_or_wrong_credentials",
			async () => {
				const noLibrary = await api(env, "/api/items", {
					authorization: "none",
				});
				const wrongLibrary = await api(env, "/api/items", {
					authorization: "library",
					token: "wrong",
				});
				const wrongExtension = await api(env, "/api/extension/config", {
					authorization: "extension",
					token: "wrong",
				});
				const noMcp = await rpc(mcpEnv, "initialize", {}, "wrong");
				equal(noLibrary.status, 401, "missing library token");
				equal(wrongLibrary.status, 401, "wrong library token");
				equal(wrongExtension.status, 401, "wrong extension token");
				equal(noMcp.status, 401, "wrong MCP token");
				return {
					library: [noLibrary.status, wrongLibrary.status],
					extension: wrongExtension.status,
					mcp: noMcp.status,
				};
			},
		);

		await check("auth.session_connect_cookie_and_rotation", async () => {
			const rejectedLogin = await handleApi(
				env,
				request("/api/auth/session", {
					method: "POST",
					body: { token: "wrong-login-token" },
					headers: { origin: ORIGIN },
				}),
			);
			equal(rejectedLogin.status, 401, "wrong login token");
			const rejectedOrigin = await handleApi(
				env,
				request("/api/auth/session", {
					method: "POST",
					body: { token: LIBRARY_TOKEN },
					headers: { origin: "https://untrusted.invalid" },
				}),
			);
			equal(rejectedOrigin.status, 403, "cross-origin session login");
			const login = await handleApi(
				env,
				request("/api/auth/session", {
					method: "POST",
					body: { token: LIBRARY_TOKEN },
					headers: { origin: ORIGIN },
				}),
			);
			const loginBody = await bodyJson(login);
			equal(login.status, 200, "session login");
			assert(
				loginBody.authenticated === true,
				"session login did not authenticate",
			);
			sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
			assert(sessionCookie, "session cookie was not issued");
			const session = await handleApi(
				env,
				request("/api/auth/session", {
					headers: { cookie: sessionCookie },
				}),
			);
			assert(
				(await bodyJson(session)).authenticated === true,
				"session cookie was rejected",
			);
			const expiredAt = Math.floor(Date.now() / 1000) - 1;
			const expiredPayload = `${expiredAt}.expired-launch-smoke`;
			const expiredSignature = createHmac("sha256", LIBRARY_TOKEN)
				.update(`anansi-session-v1:${expiredPayload}`)
				.digest("base64url");
			const expired = await handleApi(
				env,
				request("/api/stats", {
					headers: {
						cookie: `anansi_session=${expiredPayload}.${expiredSignature}`,
					},
				}),
			);
			equal(expired.status, 401, "expired signed session");
			const cookieMutation = await handleApi(
				env,
				request("/api/items/missing-smoke-item", {
					method: "PATCH",
					body: { note: "not applied" },
					headers: { cookie: sessionCookie },
				}),
			);
			equal(
				cookieMutation.status,
				403,
				"cookie mutation without same-origin header",
			);
			const sameOriginMutation = await handleApi(
				env,
				request("/api/items/missing-smoke-item", {
					method: "PATCH",
					body: { note: "not applied" },
					headers: { cookie: sessionCookie, origin: ORIGIN },
				}),
			);
			equal(
				sameOriginMutation.status,
				404,
				"same-origin cookie mutation should reach the route",
			);
			const original = env.libraryToken;
			env.libraryToken = "rotated-launch-smoke-library-token";
			const rotated = await handleApi(
				env,
				request("/api/stats", {
					headers: { cookie: sessionCookie },
				}),
			);
			env.libraryToken = original;
			equal(
				rotated.status,
				401,
				"rotated credential must invalidate the cookie",
			);
			const logout = await handleApi(
				env,
				request("/api/auth/session", {
					method: "DELETE",
					headers: { origin: ORIGIN, cookie: sessionCookie },
				}),
			);
			equal(logout.status, 200, "session logout");
			assert(
				(logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"),
				"logout did not clear cookie",
			);
			return {
				wrongLogin: rejectedLogin.status,
				crossOriginLogin: rejectedOrigin.status,
				cookie: true,
				expiredCookie: expired.status,
				cookieMutationWithoutOrigin: cookieMutation.status,
				rotatedCredential: rotated.status,
				logout: logout.status,
			};
		});

		await check(
			"capture.normalized_import_batch_and_duplicate_upsert",
			async () => {
				const items = Array.from({ length: 46 }, (_, index) =>
					normalizedWeb(index),
				);
				const first = await api(env, "/api/ingest", {
					method: "POST",
					authorization: "extension",
					body: { items },
				});
				const firstBody = await bodyJson(first);
				equal(first.status, 200, "normalized import");
				equal(firstBody.parsed, items.length, "normalized item count");
				equal(firstBody.inserted, items.length, "inserted count");
				const replay = await api(env, "/api/ingest", {
					method: "POST",
					authorization: "extension",
					body: { items: [normalizedWeb(0)] },
				});
				const replayBody = await bodyJson(replay);
				equal(replay.status, 200, "duplicate upsert");
				equal(replayBody.inserted, 0, "duplicate inserted count");
				const lookup = await bodyJson(
					await api(
						env,
						"/api/items?source=web&author=launch-author-00&limit=5",
					),
				);
				webItemId = lookup.items?.[0]?.id;
				assert(
					typeof webItemId === "string",
					"normalized import produced no queryable web item",
				);
				return {
					first: firstBody.inserted,
					duplicateInserted: replayBody.inserted,
					fixtureIdAvailable: true,
				};
			},
		);

		await check("capture.versioned_reddit_import", async () => {
			const capture = redditRawPage();
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "versioned raw-page import");
			equal(value.parsed, 1, "parsed imported items");
			const replay = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			equal(replay.status, 200, "raw-page replay");
			return {
				imported: value.parsed,
				replay: (await bodyJson(replay)).outcome,
			};
		});

		await check("capture.versioned_x_raw_page_import", async () => {
			const capture = rawPageCapture("x", "launch-smoke-x-run:page:1", xRawPage());
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "X raw-page import");
			equal(value.parsed, 1, "X raw-page parsed item count");
			return { source: "x", parsed: value.parsed, providerCalls: 0 };
		});

		await check("capture.versioned_github_raw_page_import", async () => {
			const capture = rawPageCapture("github", "launch-smoke-github-run:page:1", githubRawPage());
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "GitHub raw-page import");
			equal(value.parsed, 1, "GitHub raw-page parsed item count");
			return { source: "github", parsed: value.parsed, providerCalls: 0 };
		});

		await check("capture.versioned_tiktok_raw_page_import", async () => {
			const capture = rawPageCapture("tiktok", "launch-smoke-tiktok-run:page:1", tiktokRawPage());
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "TikTok raw-page import");
			equal(value.parsed, 1, "TikTok raw-page parsed item count");
			return { source: "tiktok", parsed: value.parsed, providerCalls: 0 };
		});

		await check("capture.native_x_save_event", async () => {
			const capture = nativeEvent();
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "native save event");
			equal(value.outcome, "created", "native save outcome");
			const itemId = value.itemId;
			assert(
				typeof itemId === "string",
				"native save returned no item id",
			);
			nativeItemId = itemId;
			await db.insert(schema.highlights).values({
				id: "launch-smoke-highlight",
				itemId,
				text: "Synthetic retained highlight",
				createdAt: SAVED_AT,
			});
			return { outcome: value.outcome, itemIdReturned: true };
		});

		await check("capture.native_event_idempotency", async () => {
			const capture = nativeEvent();
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "native event replay");
			equal(value.outcome, "created", "replayed event receipt");
			return { outcome: value.outcome, replayed: true };
		});

		await check("capture.native_x_unsave_preserves_item", async () => {
			const capture = nativeEvent({
				eventId: "launch-smoke-x-unsave",
				action: "unsave",
				observedAt: SAVED_AT + 20,
				normalizedItem: undefined,
			});
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "native unsave event");
			const itemResponse = await api(env, `/api/items/${nativeItemId}`);
			const item = await bodyJson(itemResponse);
			assert(
				item.platformSaved === false,
				"unsaved item still reports as platform-saved",
			);
			assert(item.removedFromSourceAt, "unsave timestamp was not retained");
			return {
				outcome: value.outcome,
				itemPreserved: true,
				platformSaved: item.platformSaved,
			};
		});

		await check("capture.chrome_bookmark_event_and_source_link", async () => {
			const capture = {
				schemaVersion: 1,
				payloadType: "item_event",
				eventId: "launch-smoke-chrome-bookmark",
				source: "web",
				action: "save",
				externalId: "launch-smoke-chrome-bookmark-item",
				canonicalUrl: "https://example.invalid/chrome-bookmark",
				observedAt: SAVED_AT + 2,
				captureMethod: "chrome_bookmark",
				sourceLink: {
					kind: "chrome_bookmark",
					externalId: "chrome-node-launch-smoke",
				},
				normalizedItem: {
					source: "web",
					externalId: "launch-smoke-chrome-bookmark-item",
					url: "https://example.invalid/chrome-bookmark",
					kind: "article",
					authorHandle: "chrome-smoke-author",
					title: "Chrome bookmark fixture",
					body: "Chrome bookmark event synthetic fixture",
					savedAt: SAVED_AT + 2,
					savedAtIsExact: true,
					metrics: {},
					media: [],
					links: [],
					raw: { fixture: true },
				},
			};
			const response = await api(env, "/api/ingest", {
				method: "POST",
				authorization: "extension",
				body: capture,
				headers: { "idempotency-key": capture.eventId },
			});
			const value = await bodyJson(response);
			equal(response.status, 200, "Chrome bookmark event");
			equal(value.outcome, "created", "Chrome bookmark outcome");
			return { outcome: value.outcome, sourceLink: "synthetic" };
		});

		await check("capture.toolbar_and_context_menu_events", async () => {
			const outcomes: string[] = [];
			for (const method of ["toolbar", "context_menu"] as const) {
				const id = `launch-smoke-${method}`;
				const capture = {
					schemaVersion: 1,
					payloadType: "item_event",
					eventId: id,
					source: "web",
					action: "save",
					externalId: id,
					canonicalUrl: `https://example.invalid/${method}`,
					observedAt: SAVED_AT + 3,
					captureMethod: method,
					normalizedItem: {
						source: "web",
						externalId: id,
						url: `https://example.invalid/${method}`,
						kind: "article",
						authorHandle: `${method}-smoke-author`,
						title: `${method} capture fixture`,
						body: `Synthetic ${method} capture`,
						savedAt: SAVED_AT + 3,
						savedAtIsExact: true,
						metrics: {},
						media: [],
						links: [],
						raw: { fixture: true },
					},
				};
				const response = await api(env, "/api/ingest", {
					method: "POST",
					authorization: "extension",
					body: capture,
					headers: { "idempotency-key": capture.eventId },
				});
				const value = await bodyJson(response);
				equal(response.status, 200, `${method} event`);
				outcomes.push(value.outcome);
			}
			return { methods: ["toolbar", "context_menu"], outcomes };
		});

		await check(
			"library.list_search_filters_pagination_and_detail",
			async () => {
				const first = await bodyJson(await api(env, "/api/items?limit=10"));
				equal(first.items.length, 10, "first list page size");
				assert(
					typeof first.nextCursor === "string",
					"first list page has no cursor",
				);
				const second = await bodyJson(
					await api(
						env,
						`/api/items?limit=10&cursor=${encodeURIComponent(first.nextCursor)}`,
					),
				);
				assert(
					!second.items.some((item: any) =>
						first.items.some((prior: any) => prior.id === item.id),
					),
					"list pages overlap",
				);
				const postedFirst = await bodyJson(
					await api(env, "/api/items?order=posted&limit=10"),
				);
				assert(
					typeof postedFirst.nextCursor === "string",
					"posted timeline cursor missing",
				);
				const postedSecond = await bodyJson(
					await api(
						env,
						`/api/items?order=posted&limit=10&cursor=${encodeURIComponent(postedFirst.nextCursor)}`,
					),
				);
				assert(
					!postedSecond.items.some((item: any) =>
						postedFirst.items.some((prior: any) => prior.id === item.id),
					),
					"posted timeline pages overlap",
				);
				const badCursor = await api(
					env,
					"/api/items?cursor=not-a-valid-cursor",
				);
				equal(badCursor.status, 400, "malformed list cursor");
				const bySource = await bodyJson(
					await api(env, "/api/items?source=web&limit=100"),
				);
				assert(
					bySource.items.length >= 46,
					"source filter omitted imported web items",
				);
				const byType = await bodyJson(
					await api(env, "/api/items?type=repo&limit=100"),
				);
				assert(
					byType.items.some((item: any) => item.source === "web"),
					"content type filter omitted repo item",
				);
				const media = await bodyJson(
					await api(env, "/api/items?media=image&limit=100"),
				);
				assert(
					media.items.some((item: any) => item.source === "web"),
					"image filter omitted media item",
				);
				const safeOnly = await bodyJson(await api(env, "/api/items?limit=100"));
				assert(
					!safeOnly.items.some(
						(item: any) => item.author === "launch-author-02",
					),
					"default list exposed the synthetic NSFW item",
				);
				const nsfw = await bodyJson(
					await api(env, "/api/items?nsfw=1&limit=100"),
				);
				assert(
					nsfw.items.some((item: any) => item.author === "launch-author-02"),
					"NSFW visibility option omitted the flagged synthetic item",
				);
				const search = await bodyJson(
					await api(env, "/api/search?q=quasar+recipe&limit=10"),
				);
				assert(
					search.items.some((item: any) => item.author === "launch-author-00"),
					"keyword search missed seeded text",
				);
				const emptySearch = await api(env, "/api/search?q=");
				equal(emptySearch.status, 400, "empty search query");
				const noMatchSearch = await bodyJson(
					await api(env, "/api/search?q=unmatchedzzword"),
				);
				assert(
					noMatchSearch.items.length === 0,
					"search returned a false match",
				);
				const recent = await bodyJson(
					await api(env, "/api/recent?source=x&limit=5"),
				);
				assert(
					recent.results.some((item: any) => item.id === nativeItemId),
					"recent list omitted native event",
				);
				const author = await bodyJson(
					await api(env, "/api/authors?handle=launch-smoke-author"),
				);
				assert(
					author.results.some((item: any) => item.id === nativeItemId),
					"author route omitted native event",
				);
				const stats = await bodyJson(await api(env, "/api/stats"));
				assert(
					stats.items >= 51 && stats.captureRevision > 0,
					"library statistics or capture revision missing",
				);
				if (!nativeItemId)
					throw new Error(
						"native capture prerequisite did not return an item id",
					);
				const detailResponse = await api(env, `/api/items/${nativeItemId}`);
				const detail = await bodyJson(detailResponse);
				equal(detailResponse.status, 200, "item detail route");
				assert(
					detail.fullText.includes("native bookmark capture"),
					"detail omitted saved text",
				);
			assert(
				detail.highlights.some((highlight: any) => highlight.text === "Synthetic retained highlight"),
				"detail omitted saved highlight",
			);
				assert(
					detail.media.some((entry: any) => entry.kind === "image"),
					"detail omitted media metadata",
				);
				assert(
					detail.links.includes("https://example.invalid/native-link"),
					"detail omitted links",
				);
				assert(!("raw" in detail), "detail exposed the raw provider payload");
				const missing = await api(env, "/api/items/missing-smoke-item");
				equal(missing.status, 404, "missing detail route");
				const removed = await bodyJson(
					await api(env, "/api/items?removed=only&source=x"),
				);
				assert(
					removed.items.some((item: any) => item.id === nativeItemId),
					"removed-source filter omitted unsaved item",
				);
				return {
					firstPage: first.items.length,
					secondPage: second.items.length,
					postedPages: [postedFirst.items.length, postedSecond.items.length],
					webItems: bySource.items.length,
					searchHits: search.items.length,
					detailMedia: detail.media.length,
					removedItems: removed.items.length,
					statsItems: stats.items,
				};
			},
		);

		await check(
			"library.creators_search_pagination_and_author_navigation",
			async () => {
				const first = await bodyJson(await api(env, "/api/creators?limit=20"));
				equal(first.creators.length, 20, "creator first page size");
				assert(typeof first.nextCursor === "string", "creator cursor missing");
				const second = await bodyJson(
					await api(
						env,
						`/api/creators?limit=20&cursor=${encodeURIComponent(first.nextCursor)}`,
					),
				);
				assert(
					!second.creators.some((creator: any) =>
						first.creators.some(
							(prior: any) =>
								prior.authorHandle === creator.authorHandle &&
								prior.source === creator.source,
						),
					),
					"creator pages overlap",
				);
				const filtered = await bodyJson(
					await api(env, "/api/creators?q=launch-author-00"),
				);
				assert(
					filtered.creators.some(
						(creator: any) => creator.authorHandle === "launch-author-00",
					),
					"creator query missed the matching author",
				);
				const sourceFiltered = await bodyJson(
					await api(env, "/api/creators?source=web&limit=100"),
				);
				assert(
					sourceFiltered.creators.length >= 46,
					"creator source filter omitted synthetic web authors",
				);
				return {
					firstPage: first.creators.length,
					secondPage: second.creators.length,
					queried: filtered.creators.length,
				};
			},
		);

		await check("library.note_favorite_tags_and_archive_actions", async () => {
			if (!nativeItemId)
				throw new Error(
					"native capture prerequisite did not return an item id",
				);
			const update = await api(env, `/api/items/${nativeItemId}`, {
				method: "PATCH",
				authorization: "library",
				body: { note: "Synthetic acceptance note", favorite: true },
			});
			const updated = await bodyJson(update);
			equal(update.status, 200, "item PATCH");
			assert(
				updated.favorite === true &&
					updated.note === "Synthetic acceptance note",
				"note or favorite did not persist",
			);
			const favorite = await bodyJson(
				await api(env, "/api/items?favorite=1&source=x"),
			);
			assert(
				favorite.items.some((item: any) => item.id === nativeItemId),
				"favorite filter omitted updated item",
			);
			const addTag = await api(env, `/api/items/${nativeItemId}/tags`, {
				method: "POST",
				body: { label: "launch smoke item tag" },
			});
			equal(addTag.status, 200, "item tag add");
			if (!webItemId)
				throw new Error(
					"normalized import prerequisite did not return a web item id",
				);
			const bulkTag = await api(env, "/api/items/tag", {
				method: "POST",
				body: {
					ids: [nativeItemId, webItemId],
					label: "launch smoke bulk tag",
				},
			});
			const bulkTagBody = await bodyJson(bulkTag);
			equal(bulkTag.status, 200, "bulk tag action");
			assert(
				bulkTagBody.tagged >= 2,
				"bulk tag reported fewer changes than the selected items",
			);
			const tagList = await bodyJson(await api(env, "/api/tags"));
			includes(
				tagList.tags.map((tag: any) => tag.label),
				"launch smoke item tag",
				"tag list missed item tag",
			);
			includes(
				tagList.tags.map((tag: any) => tag.label),
				"launch smoke bulk tag",
				"tag list missed bulk tag",
			);
			const tagged = await bodyJson(
				await api(env, "/api/items?tag=launch%20smoke%20item%20tag"),
			);
			assert(
				tagged.items.some((item: any) => item.id === nativeItemId),
				"tag filter omitted updated item",
			);
			const archived = await api(env, `/api/items/${nativeItemId}`, {
				method: "PATCH",
				body: { archived: true },
			});
			assert(
				(await bodyJson(archived)).archived === true,
				"item archive PATCH failed",
			);
			const archivePage = await bodyJson(
				await api(env, "/api/items?archived=1&source=x"),
			);
			assert(
				archivePage.items.some((item: any) => item.id === nativeItemId),
				"archive filter omitted updated item",
			);
			const unarchived = await api(env, `/api/items/${nativeItemId}`, {
				method: "PATCH",
				body: { archived: false },
			});
			assert(
				(await bodyJson(unarchived)).archived === false,
				"item unarchive PATCH failed",
			);
			const removedTag = await api(env, `/api/items/${nativeItemId}/tags`, {
				method: "DELETE",
				body: { label: "launch smoke item tag" },
			});
			equal(removedTag.status, 200, "item tag delete");
			const finalDetail = await bodyJson(
				await api(env, `/api/items/${nativeItemId}`),
			);
			assert(
				!finalDetail.tags.includes("launch smoke item tag"),
				"deleted item tag remains attached",
			);
			const bulkArchive = await api(env, "/api/items/archive", {
				method: "POST",
				body: { ids: [nativeItemId, webItemId], archived: true },
			});
			const bulkArchiveBody = await bodyJson(bulkArchive);
			equal(bulkArchive.status, 200, "bulk archive action");
			assert(bulkArchiveBody.changed >= 1, "bulk archive reported no changes");
			await api(env, "/api/items/archive", {
				method: "POST",
				body: { ids: [nativeItemId, webItemId], archived: false },
			});
			return {
				note: true,
				favorite: true,
				itemTag: true,
				bulkTag: true,
				archiveAndRestore: true,
			};
		});

		await check("library.saved_views_create_apply_delete", async () => {
			const created = await api(env, "/api/collections", {
				method: "POST",
				body: {
					id: "launch-smoke-collection",
					name: "Launch smoke saved view",
					filters: {
						source: ["web"],
						author: ["launch-author-00"],
						cursor: "discard-this",
						limit: 1,
					},
				},
			});
			const value = await bodyJson(created);
			equal(created.status, 200, "collection create");
			assert(
				value.collection.filters.source.includes("web"),
				"collection filters were not saved",
			);
			assert(
				!("cursor" in value.collection.filters) &&
					!("limit" in value.collection.filters),
				"transient pagination was saved into the view",
			);
			const listed = await bodyJson(await api(env, "/api/collections"));
			assert(
				listed.collections.some(
					(collection: any) => collection.id === "launch-smoke-collection",
				),
				"collection list omitted created view",
			);
			const applied = await bodyJson(
				await api(env, "/api/items?source=web&author=launch-author-00"),
			);
			assert(
				applied.items.length === 1,
				"saved view filters did not produce the expected library result",
			);
			const deleted = await api(
				env,
				"/api/collections/launch-smoke-collection",
				{ method: "DELETE" },
			);
			equal(deleted.status, 200, "collection delete");
			const afterDelete = await bodyJson(await api(env, "/api/collections"));
			assert(
				!afterDelete.collections.some(
					(collection: any) => collection.id === "launch-smoke-collection",
				),
				"deleted collection remains listed",
			);
			return { created: true, filtersApplied: true, deleted: true };
		});

		await check(
			"sources.catalog_health_toggle_config_and_heartbeat",
			async () => {
				const sources = await bodyJson(await api(env, "/api/sources"));
				const names = sources.sources.map((source: any) => source.source);
				for (const source of ["x", "reddit", "github", "tiktok", "web"])
					includes(names, source, `source catalog missing ${source}`);
				const configResponse = await api(env, "/api/extension/config", {
					authorization: "extension",
				});
				const config = await bodyJson(configResponse);
				equal(configResponse.status, 200, "extension config");
				assert(
					config.features.captureV2.x === true &&
						config.features.chromeBookmarks === true,
					"extension capture feature flags missing",
				);
				assert(
					!JSON.stringify(config).includes(INGEST_TOKEN),
					"extension config leaked the ingest credential",
				);
				const before = config.sources.some(
					(source: any) => source.source === "reddit",
				);
				assert(before, "Reddit source absent before toggle");
				const disabled = await api(env, "/api/sources/reddit", {
					method: "POST",
					body: { enabled: false },
				});
				equal(disabled.status, 200, "source disable");
				const offConfig = await bodyJson(
					await api(env, "/api/extension/config", {
						authorization: "extension",
					}),
				);
				assert(
					!offConfig.sources.some((source: any) => source.source === "reddit"),
					"disabled source remains in extension config",
				);
				const enabled = await api(env, "/api/sources/reddit", {
					method: "POST",
					body: { enabled: true },
				});
				equal(enabled.status, 200, "source enable");
				const badToggle = await api(env, "/api/sources/web", {
					method: "POST",
					body: { enabled: false },
				});
				equal(badToggle.status, 400, "non-toggleable Web source");
				const heartbeat = {
					schemaVersion: 1,
					installationId: "a42c2aa1-ef81-4bfe-a827-b28f781c30f0",
					extensionVersion: "0.1.0-smoke",
					queue: { queued: 1, uploading: 0, retrying: 0, failed: 0 },
					sources: {
						x: {
							queued: 1,
							uploading: 0,
							retrying: 0,
							failed: 0,
							phase: "running",
							paused: false,
						},
					},
				};
				const heartbeatResponse = await api(env, "/api/extension/heartbeat", {
					method: "POST",
					authorization: "extension",
					body: heartbeat,
				});
				equal(heartbeatResponse.status, 200, "extension heartbeat");
				const after = await bodyJson(await api(env, "/api/sources"));
				assert(
					after.extension.connection === "connected",
					"heartbeat did not mark extension connected",
				);
				const extensionStats = await api(env, "/api/extension/stats", {
					authorization: "extension",
				});
				equal(extensionStats.status, 200, "extension stats");
				return {
					catalog: names.length,
					toggled: true,
					heartbeat: after.extension.connection,
					configSources: config.sources.length,
				};
			},
		);

		await check(
			"library.export_and_empty_library_resumable_restore",
			async () => {
				const exportResponse = await api(env, "/api/export");
				equal(exportResponse.status, 200, "library export");
				assert(
					(exportResponse.headers.get("content-disposition") ?? "").includes(
						"anansi-library.json",
					),
					"export is missing its download filename",
				);
				const exportText = await exportResponse.text();
				const parsed = JSON.parse(exportText) as LibraryExport;
				const validated = validateRestoreBackup(structuredClone(parsed));
				const backup = validated.backup;
				const counts = restoreCounts(backup);
				assert(
					counts.items >= 50,
					"export did not include the synthetic library",
				);
				const badFile = structuredClone(backup) as unknown as Record<
					string,
					unknown
				>;
				badFile.version = 999;
				let invalidRejected = false;
				try {
					validateRestoreBackup(badFile);
				} catch {
					invalidRejected = true;
				}
				assert(
					invalidRejected,
					"restore preflight accepted an unsupported export version",
				);
				const targetLocal = openLocalDb(":memory:");
				closeables.push(
					(targetLocal as unknown as { $client?: { close?: () => void } })
						.$client ?? {},
				);
				migrateLocalDb(targetLocal);
				const target = targetLocal as unknown as AnansiDb;
				const targetEnv: ApiEnv = { db: target, libraryToken: LIBRARY_TOKEN };
				const backupId = createHash("sha256").update(exportText).digest("hex");
				const start = await api(targetEnv, "/api/restore/start", {
					method: "POST",
					body: { backupId, counts },
				});
				const startBody = await bodyJson(start);
				equal(start.status, 200, "restore start");
				let restore = startBody.restore;
				const firstRows = backup.items.slice(0, PAGE_SIZE);
				const firstChunk = await api(targetEnv, "/api/restore/chunk", {
					method: "POST",
					body: { backupId, table: "items", offset: 0, rows: firstRows },
				});
				equal(firstChunk.status, 200, "restore first chunk");
				const interrupted = await bodyJson(
					await api(targetEnv, "/api/restore"),
				);
				assert(
					interrupted.restore.progress.items === firstRows.length,
					"restore cursor was not persisted after interruption",
				);
				const invalidChunk = await api(targetEnv, "/api/restore/chunk", {
					method: "POST",
					body: {
						backupId,
						table: "items",
						offset: firstRows.length,
						rows: [{ id: "invalid-smoke-row" }],
					},
				});
				equal(invalidChunk.status, 400, "invalid restore chunk rejection");
				for (const table of RESTORE_TABLES) {
					const rows = (backup[table] ?? []) as unknown[];
					let offset = table === "items" ? firstRows.length : 0;
					while (offset < rows.length) {
						const chunk = rows.slice(offset, offset + PAGE_SIZE);
						const response = await api(targetEnv, "/api/restore/chunk", {
							method: "POST",
							body: { backupId, table, offset, rows: chunk },
						});
						const value = await bodyJson(response);
						equal(response.status, 200, `restore ${table} chunk at ${offset}`);
						restore = value.restore;
						offset += chunk.length;
					}
				}
				const finish = await api(targetEnv, "/api/restore/finish", {
					method: "POST",
					body: { backupId },
				});
				const finishBody = await bodyJson(finish);
				equal(finish.status, 200, "restore finish");
				equal(
					finishBody.restore.status,
					"complete",
					"restore completion state",
				);
				const restoredStats = await bodyJson(
					await api(targetEnv, "/api/stats"),
				);
				equal(restoredStats.items, counts.items, "restored library item count");
				return {
					exportedItems: counts.items,
					resumedAt: firstRows.length,
					restoredItems: restoredStats.items,
					invalidFileRejected: true,
					invalidChunkStatus: invalidChunk.status,
				};
			},
		);

		await check("restore.preflight_rejects_invalid_export", async () => {
			let rejected = false;
			try {
				validateRestoreBackup({ format: "not-anansi", version: 1 });
			} catch {
				rejected = true;
			}
			assert(rejected, "invalid export preflight did not reject the input");
			return {
				invalidExportRejected: true,
				method: "pure preflight used by browser restore",
			};
		});

		await check(
			"media.synthetic_serving_and_unsafe_key_rejection",
			async () => {
				const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
				const mediaEnv: ApiEnv = {
					...env,
					media: {
						bucket: {
							get: async (key: string) =>
								key === "ab/cd/synthetic.png"
									? {
											body: new ReadableStream({
												start(controller) {
													controller.enqueue(bytes);
													controller.close();
												},
											}),
											httpMetadata: { contentType: "image/png" },
										}
									: null,
						},
					},
				};
				const served = await api(mediaEnv, "/api/media/ab/cd/synthetic.png");
				equal(served.status, 200, "synthetic stored media");
				equal(
					served.headers.get("x-content-type-options"),
					"nosniff",
					"media safety header",
				);
				equal(
					(await served.arrayBuffer()).byteLength,
					bytes.byteLength,
					"served media byte length",
				);
				const invalidKey = await api(
					mediaEnv,
					"/api/media/not-a-generated-key",
				);
				equal(invalidKey.status, 400, "unsafe media key");
				const retryUnavailable = await api(env, "/api/media/retry", {
					method: "POST",
					body: {},
				});
				equal(
					retryUnavailable.status,
					503,
					"media retry without storage binding",
				);
				return {
					storedMedia: served.status,
					invalidKey: invalidKey.status,
					retryWithoutBinding: retryUnavailable.status,
					networkFetches: 0,
				};
			},
		);

		await check(
			"mcp.http_transport_all_eight_tools_filters_cursor_and_bounds",
			async () => {
				const initialized = await rpc(mcpEnv, "initialize", {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "launch-feature-smoke", version: "1" },
				});
				equal(initialized.status, 200, "MCP initialize");
				const listed = await rpc(mcpEnv, "tools/list");
				equal(listed.status, 200, "MCP tools/list");
				const names = (listed.value?.result?.tools ?? []).map(
					(tool: any) => tool.name,
				);
				for (const name of [
					"search_saved",
					"get_saved",
					"get_saved_many",
					"list_saved",
					"list_recent_saves",
					"list_author_saves",
					"list_tags",
					"library_stats",
				])
					includes(names, name, `MCP tool missing ${name}`);
				if (!nativeItemId || !webItemId)
					throw new Error(
						"capture fixture prerequisites were not available for MCP",
					);
				const calls: Record<string, any> = {};
				for (const [name, args] of [
					["search_saved", { query: "quasar recipe", limit: 5 }],
					["get_saved", { id: nativeItemId }],
					["get_saved_many", { ids: [nativeItemId, webItemId] }],
					[
						"list_saved",
						{ source: "x", favorite: true, media: "image", limit: 2 },
					],
					["list_recent_saves", { source: "x", limit: 5 }],
					["list_author_saves", { handle: "@launch-smoke-author", limit: 5 }],
					["list_tags", {}],
					["library_stats", {}],
				] as const) {
					const response = await rpc(mcpEnv, "tools/call", {
						name,
						arguments: args,
					});
					equal(response.status, 200, `${name} MCP HTTP status`);
					assert(!response.value?.error, `${name} MCP protocol error`);
					calls[name] = mcpPayload(response.value);
				}
				assert(
					calls.search_saved.count > 0,
					"search_saved returned no matching seeded text",
				);
				assert(
					calls.get_saved.full_text.includes("native bookmark capture"),
					"get_saved omitted item text",
				);
			assert(
				calls.get_saved.highlights.some((highlight: any) => highlight.text === "Synthetic retained highlight"),
				"get_saved omitted saved highlight",
			);
				assert(
					calls.get_saved_many.items.length === 2,
					"get_saved_many did not return both items",
				);
				assert(
					calls.list_saved.results.some(
						(item: any) => item.id === nativeItemId,
					),
					"list_saved filters omitted the native item",
				);
				assert(
					calls.list_recent_saves.results.some(
						(item: any) => item.id === nativeItemId,
					),
					"list_recent_saves omitted the native item",
				);
				assert(
					calls.list_author_saves.count > 0,
					"list_author_saves returned no matching saves",
				);
				assert(
					calls.list_tags.tags.some(
						(tag: any) => tag.label === "launch smoke bulk tag",
					),
					"list_tags omitted the synthetic tag",
				);
				assert(
					calls.library_stats.items > 0,
					"library_stats returned no items",
				);
				const searchFirst = await rpc(mcpEnv, "tools/call", {
					name: "search_saved",
					arguments: { query: "launch smoke", limit: 2 },
				});
				const searchFirstPayload = mcpPayload(searchFirst.value);
				assert(
					typeof searchFirstPayload.next_cursor === "string",
					"search_saved did not return a relevance cursor",
				);
				const searchSecond = await rpc(mcpEnv, "tools/call", {
					name: "search_saved",
					arguments: {
						query: "launch smoke",
						limit: 2,
						cursor: searchFirstPayload.next_cursor,
					},
				});
				const searchSecondPayload = mcpPayload(searchSecond.value);
				assert(
					!searchSecondPayload.results.some((item: any) =>
						searchFirstPayload.results.some(
							(prior: any) => prior.id === item.id,
						),
					),
					"MCP search cursor pages overlap",
				);
				const first = await rpc(mcpEnv, "tools/call", {
					name: "list_saved",
					arguments: { source: "web", limit: 2 },
				});
				const firstList = mcpPayload(first.value);
				assert(
					typeof firstList.next_cursor === "string",
					"list_saved did not return a cursor",
				);
				const second = await rpc(mcpEnv, "tools/call", {
					name: "list_saved",
					arguments: { source: "web", limit: 2, cursor: firstList.next_cursor },
				});
				const secondList = mcpPayload(second.value);
				assert(
					!secondList.results.some((item: any) =>
						firstList.results.some((prior: any) => prior.id === item.id),
					),
					"MCP cursor pages overlap",
				);
				const outOfBounds = await rpc(mcpEnv, "tools/call", {
					name: "list_saved",
					arguments: { limit: 51 },
				});
				assert(
					outOfBounds.value?.result?.isError === true ||
						outOfBounds.value?.error,
					"MCP accepted a list limit above 50",
				);
				return {
					toolNames: names,
					called: Object.keys(calls),
					filtered: true,
					listCursorPages: [
						firstList.results.length,
						secondList.results.length,
					],
					searchCursorPages: [
						searchFirstPayload.results.length,
						searchSecondPayload.results.length,
					],
					boundsRejected: true,
				};
			},
		);

		await check(
			"mcp.http_transport_denies_missing_and_wrong_token",
			async () => {
				const wrong = await rpc(
					mcpEnv,
					"tools/list",
					{},
					"incorrect-smoke-token",
				);
				equal(wrong.status, 401, "wrong MCP token");
				const noToken = await handleMcp(
					{ db },
					new Request(`${ORIGIN}/mcp`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/list",
						}),
					}),
				);
				equal(noToken.status, 503, "unconfigured MCP endpoint");
				return {
					wrongToken: wrong.status,
					missingConfiguration: noToken.status,
				};
			},
		);

		await check(
			"ai.unavailable_disabled_and_enablement_rejected_without_bindings",
			async () => {
				const stateResponse = await api(env, "/api/ai");
				const state = await bodyJson(stateResponse);
				equal(stateResponse.status, 200, "AI settings route");
				assert(
					state.available === false && state.runtime === "none",
					"AI should report unavailable without a binding",
				);
				assert(
					state.capabilities.semanticSearch === false &&
						state.capabilities.autoTagging === false,
					"AI capabilities should be unavailable without bindings",
				);
				assert(
					state.settings.semanticSearchEnabled === 0 &&
						state.settings.autoTaggingEnabled === 0,
					"AI options were not disabled by default",
				);
				const preview = await api(env, "/api/ai/semantic-preview");
				equal(
					preview.status,
					503,
					"semantic preview without provider bindings",
				);
				const enable = await api(env, "/api/ai", {
					method: "PATCH",
					body: { semanticSearchEnabled: true, confirmSemanticBackfill: true },
				});
				equal(
					enable.status,
					503,
					"semantic enablement without provider bindings",
				);
				const reclassify = await api(env, "/api/ai/reclassify", {
					method: "POST",
					body: {},
				});
				equal(
					reclassify.status,
					200,
					"local topic reclassification without provider bindings",
				);
				return {
					available: state.available,
					runtime: state.runtime,
					semanticPreview: preview.status,
					enablement: enable.status,
					providerCalls: 0,
				};
			},
		);

		// A malformed return from the capture path must be recorded as a failure,
		// even when later independent API/MCP checks pass.
		await check(
			"capture.rejected_malformed_payload_is_not_acknowledged",
			async () => {
				const capture = nativeEvent({
					eventId: "launch-smoke-invalid-event",
					normalizedItem: {
						...normalizedX(),
						externalId: "launch-smoke-invalid-event",
						savedAt: "not-a-time",
					},
				});
				const response = await api(env, "/api/ingest", {
					method: "POST",
					authorization: "extension",
					body: capture,
					headers: { "idempotency-key": capture.eventId },
				});
				equal(response.status, 400, "malformed capture rejection");
				return { status: response.status, acknowledged: false };
			},
		);

		if (!webItemId)
			blocked(
				"fixture.lookup_web_item_id",
				"The normalized import check did not produce a queryable web item.",
			);
		if (!nativeItemId)
			blocked(
				"fixture.lookup_native_item_id",
				"The native capture check did not return an item ID.",
			);

		const result = {
			schemaVersion: 1,
			mode: "synthetic-local-api-and-mcp",
			database:
				"isolated in-memory SQLite migrated from the current @anansi/db migrations",
			providers: {
				network: "none",
				ai: "unavailable; no binding configured",
				mediaFetch: "none; media serving used a synthetic bucket response",
			},
			checks,
			coverage: {
				automatedLocal:
					"Direct current handler checks against the migrated in-memory database.",
				browserEvidence:
					"Not covered: visual states, routes/navigation/theme, grid/row/timeline interaction, palette, extension popup/service worker/permissions/queue lifecycle.",
				providerEvidence:
					"Not covered: authenticated X, Reddit, GitHub, or TikTok imports/events, provider sign-in, live outage recovery, or real Chrome capture.",
				cloudflareEvidence:
					"Not covered: Worker/D1/R2/Vectorize bindings, deployed headers/cookies, scheduled jobs, production quotas, or deployment configuration.",
				importParsers:
					"Synthetic normalized batch and raw-page import parsers for X, Reddit, GitHub, and TikTok were exercised; native X and Web toolbar/context-menu/Chrome bookmark event shapes were exercised.",
				aiEnabled:
					"Not covered: AI-enabled execution; the smoke proves the no-binding disabled state and that semantic enablement is rejected without bindings.",
				media:
					"Serving and generated-key rejection were checked with an in-memory bucket stub; remote fetch, retry after outage, and stored bytes were not exercised.",
			},
			failedChecks: failures,
			status: failures.length === 0 ? "passed" : "failed",
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (failures.length > 0) process.exitCode = 1;
	} finally {
		for (const client of closeables) client.close?.();
	}
}

await main();
