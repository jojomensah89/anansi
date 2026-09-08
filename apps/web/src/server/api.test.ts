import { beforeAll, describe, expect, test } from "bun:test";
import { aiEnrichmentJobs, applyAiTags, itemTags, reconcileAiJobs, searchItemsPage, setAiSettings, upsertItems, type AnansiDb } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { handleApi as dispatchApi, type ApiEnv } from "./api.ts";
import { LocalVectorIndex } from "./local-vector-index.ts";

/**
 * The HTTP surface, tested against a fully migrated in-memory library with no
 * framework in the way. That is the point of handleApi being a plain function: these
 * assertions hold whatever TanStack's route-file API looks like this month,
 * and they will keep holding when the same function runs on D1 in a Worker.
 */
const localDb = openLocalDb(":memory:");
migrateLocalDb(localDb);
const db = localDb as unknown as AnansiDb;
const env = { db, ingestToken: "test-token", libraryToken: "library-test-token" };
const handleApi = (environment: ApiEnv, request: Request) => {
  const path = new URL(request.url).pathname;
  if (path !== "/api/ingest" && path !== "/api/extension/heartbeat") request.headers.set("authorization", `Bearer ${path.startsWith("/api/extension/") ? "test-token" : "library-test-token"}`);
  return dispatchApi(environment, request);
};

beforeAll(async () => {
	await upsertItems(
		db,
		Array.from({ length: 12 }, (_, index) => ({
			source: "x",
			externalId: `seed-${index}`,
			url: `https://x.com/anansi/status/seed-${index}`,
			kind: "post",
			authorHandle: index % 2 === 0 ? "anansi" : "arachne",
			authorName: index % 2 === 0 ? "Anansi" : "Arachne",
			body: index === 0 ? "ai sdk artifacts" : `seed item ${index}`,
			postedAt: 1_788_390_000 - index,
			savedAt: 1_788_390_000 - index,
			savedAtIsExact: true,
			saveOrder: 10_000 - index,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		})),
	);
});

const get = (path: string) =>
	handleApi(env, new Request("https://anansi.test" + path));

// Response.json() is typed `unknown` here; these are assertions about a shape
// we control, so read it as any rather than sprinkling casts.
const readJson = async (res: Response | Promise<Response>): Promise<any> =>
	(await (await res).json()) as any;

describe("handleApi", () => {
	test("GET /api/stats reports the library size", async () => {
		const body = await readJson(get("/api/stats"));
		expect(body.items).toBeGreaterThan(0);
	});

	test("GET /api/items paginates by keyset, not offset", async () => {
		const first = await readJson(get("/api/items?limit=5"));
		expect(first.items).toHaveLength(5);
		// Opaque on purpose: its shape depends on the order asked for.
		expect(first.nextCursor).toBeString();

		const second = await readJson(
			get(`/api/items?limit=5&cursor=${first.nextCursor}`),
		);
		const overlap = second.items.filter((i: { id: string }) =>
			first.items.some((f: { id: string }) => f.id === i.id),
		);
		expect(overlap).toHaveLength(0);
	});

	test("GET /api/items rejects a malformed cursor", async () => {
		const res = await get("/api/items?cursor=not-a-cursor");
		expect(res.status).toBe(400);
		expect(await readJson(res)).toEqual({ error: "invalid saved cursor" });
	});

	/**
	 * The property that matters for Timeline: paging the whole library in date
	 * order reaches every item exactly once. Two posts can share a second, so a
	 * cursor that cannot break that tie drops or repeats items at any page
	 * boundary that lands on one.
	 */
	test("order=posted walks the whole library, in order, without repeats", async () => {
		const seen = new Set<string>();
		let cursor: string | null = null;
		let previous = Number.POSITIVE_INFINITY;
		let pages = 0;

		do {
			const q = new URLSearchParams({ order: "posted", limit: "200" });
			if (cursor) q.set("cursor", cursor);
			const page = await readJson(get(`/api/items?${q}`));
			pages++;
			for (const item of page.items) {
				expect(seen.has(item.id)).toBe(false);
				seen.add(item.id);
				const at = item.postedAt ?? 0;
				expect(at).toBeLessThanOrEqual(previous);
				previous = at;
			}
			cursor = page.nextCursor;
		} while (cursor && pages < 25);

		const stats = await readJson(get("/api/stats"));
		expect(seen.size).toBe(stats.items);
	});

	test("GET /api/search returns bm25-ranked hits", async () => {
		const body = await readJson(get("/api/search?q=ai+sdk+artifacts&limit=3"));
		expect(body.results.length).toBeGreaterThan(0);
		expect(body.results[0].url).toStartWith("https://");
	});

	test("GET /api/search rejects an empty query rather than returning everything", async () => {
		expect((await get("/api/search?q=")).status).toBe(400);
	});

	test("a hostile query returns no results rather than a 500", async () => {
		const res = await get(
			"/api/search?q=" + encodeURIComponent("it's a * mess (AND"),
		);
		expect(res.status).toBe(200);
		expect((await readJson(res)).results).toEqual([]);
	});

	test("GET /api/tags exposes canonical topic kinds", async () => {
		const body = await readJson(get("/api/tags"));
		expect(body.tags.some((tag: { label: string; kind: string }) => tag.label === "Web Dev" && tag.kind === "topic")).toBe(true);
	});

	test("POST /api/ai/reclassify clears AI assignments and reopens tagging jobs", async () => {
		const item = (await searchItemsPage(db, { query: "seed", limit: 1 })).items[0];
		if (!item) throw new Error("expected seeded item");
		await setAiSettings(db, { autoTaggingEnabled: true });
		await reconcileAiJobs(db, 100, undefined, ["tagging"]);
		expect((await db.select().from(aiEnrichmentJobs)).length).toBeGreaterThan(0);
		await db.update(aiEnrichmentJobs).set({ status: "complete" }).run();
		await applyAiTags(db, item.id, ["web-dev"], "test-model");
		const response = await handleApi(env, new Request("https://anansi.test/api/ai/reclassify", { method: "POST" }));
		const first = await readJson(response);
		expect(response.status).toBe(200);
		expect((await db.select().from(itemTags)).some((assignment) => assignment.itemId === item.id && assignment.provenance === "ai")).toBe(false);
		expect(first.taxonomyVersion).toBe("v1");
		expect(first.taggingProgress.pending).toBeGreaterThan(0);
		const jobsAfterFirst = await db.select().from(aiEnrichmentJobs);
		await applyAiTags(db, item.id, ["web-dev"], "test-model");
		const repeated = await handleApi(env, new Request("https://anansi.test/api/ai/reclassify", { method: "POST" }));
		const second = await readJson(repeated);
		expect(second.taggingProgress.pending).toBe(first.taggingProgress.pending);
		expect((await db.select().from(aiEnrichmentJobs)).length).toBe(jobsAfterFirst.length);
		expect((await db.select().from(itemTags)).some((assignment) => assignment.itemId === item.id && assignment.provenance === "ai")).toBe(true);
	});

	test("semantic-only candidates are hydrated and filtered by D1", async () => {
		await upsertItems(db, [
			{
				source: "x",
				externalId: "semantic-only",
				url: "https://x.com/anansi/status/semantic-only",
				kind: "post",
				authorHandle: "semantic-author",
				body: "A bookmark about neighbouring vector indexes",
				savedAt: 1_788_390_100,
				savedAtIsExact: true,
				metrics: {}, media: [], links: [], raw: {},
			},
		]);
		const semanticRow = (await searchItemsPage(db, { query: "neighbouring vector indexes", limit: 1 })).items[0];
		if (!semanticRow) throw new Error("semantic fixture was not indexed");
		const semanticVector = [1, ...Array.from({ length: 383 }, () => 0)];
		const index = new LocalVectorIndex(384);
		await index.upsert([
			{ id: semanticRow.id, values: semanticVector },
			{ id: "hidden-or-deleted", values: semanticVector },
		]);
		await setAiSettings(db, { semanticSearchEnabled: true });
		const semanticEnv: ApiEnv = {
			...env,
			ai: { run: async () => ({ data: [semanticVector] }) },
			vectorize: {
				upsert: async (vectors) => { await index.upsert(vectors); },
				query: async (values, options) => ({ matches: await index.query(values, options) }),
				deleteByIds: async (ids) => { await index.deleteByIds(ids); },
			},
		};
		try {
			const body = await readJson(handleApi(semanticEnv, new Request("https://anansi.test/api/search?q=unmatched+phrase", {
				headers: { authorization: "Bearer library-test-token" },
			})));
			expect(body.semantic).toEqual({ enabled: true, applied: true });
			expect(body.nextCursor).toBeNull();
			expect(body.results.map((item: { id: string }) => item.id)).toContain(semanticRow.id);
			expect(body.results.map((item: { id: string }) => item.id)).not.toContain("hidden-or-deleted");
			const filtered = await readJson(handleApi(semanticEnv, new Request("https://anansi.test/api/search?q=unmatched+phrase&author=someone-else", {
				headers: { authorization: "Bearer library-test-token" },
			})));
			expect(filtered.results.map((item: { id: string }) => item.id)).not.toContain(semanticRow.id);
		} finally {
			await setAiSettings(db, { semanticSearchEnabled: false });
		}
	});

	test("failed semantic providers fall back to BM25 with a safe diagnostic", async () => {
		await setAiSettings(db, { semanticSearchEnabled: true });
		const failingEnv: ApiEnv = {
			...env,
			ai: { run: async () => { throw new Error("simulated provider outage"); } },
			vectorize: { upsert: async () => {}, query: async () => ({ matches: [] }) },
		};
		try {
			const body = await readJson(handleApi(failingEnv, new Request("https://anansi.test/api/search?q=ai+sdk+artifacts", {
				headers: { authorization: "Bearer library-test-token" },
			})));
			expect(body.results.length).toBeGreaterThan(0);
			expect(body.semantic).toEqual({ enabled: true, applied: false, degradedReason: "provider-unavailable" });
		} finally {
			await setAiSettings(db, { semanticSearchEnabled: false });
		}
	});

	test("an empty warming semantic index preserves the lexical page", async () => {
		await setAiSettings(db, { semanticSearchEnabled: true });
		const vector = [1, ...Array.from({ length: 383 }, () => 0)];
		const emptyIndex = new LocalVectorIndex(384);
		const warmingEnv: ApiEnv = {
			...env,
			ai: { run: async () => ({ data: [vector] }) },
			vectorize: { upsert: async () => {}, query: async (values, options) => ({ matches: await emptyIndex.query(values, options) }) },
		};
		try {
			const body = await readJson(handleApi(warmingEnv, new Request("https://anansi.test/api/search?q=ai+sdk+artifacts", {
				headers: { authorization: "Bearer library-test-token" },
			})));
			expect(body.results.length).toBeGreaterThan(0);
			expect(body.semantic).toMatchObject({ enabled: true, applied: false });
		} finally {
			await setAiSettings(db, { semanticSearchEnabled: false });
		}
	});

	test("local runtime exposes automatic tags when a tagger is configured", async () => {
		let kicks = 0;
		const localEnv: ApiEnv = {
			...env,
			semantic: {
				local: true,
				provider: { model: "local", dimensions: 384, embed: async () => [1, ...Array.from({ length: 383 }, () => 0)] },
				index: new LocalVectorIndex(384),
			},
			tagger: { model: "tag-model", generateTags: async () => ["local"] },
			taggingKick: () => { kicks += 10; },
			semanticKick: () => { kicks += 1; },
		};
		const headers = { authorization: "Bearer library-test-token", "content-type": "application/json" };
		const tags = await handleApi(localEnv, new Request("https://anansi.test/api/ai", { method: "PATCH", headers, body: JSON.stringify({ autoTaggingEnabled: true }) }));
		expect(tags.status).toBe(200);
		expect(kicks).toBe(10);
		const semantic = await handleApi(localEnv, new Request("https://anansi.test/api/ai", { method: "PATCH", headers, body: JSON.stringify({ semanticSearchEnabled: true }) }));
		expect(semantic.status).toBe(200);
		expect(kicks).toBe(11);
		const status = await readJson(handleApi(localEnv, new Request("https://anansi.test/api/ai", { headers })));
		expect(status.capabilities).toEqual({ semanticSearch: true, autoTagging: true });
		await setAiSettings(db, { semanticSearchEnabled: false, autoTaggingEnabled: false });
	});

	test("local automatic tags require a configured tagger", async () => {
		const localEnv: ApiEnv = {
			...env,
			semantic: {
				local: true,
				provider: { model: "local", dimensions: 384, embed: async () => [1, ...Array.from({ length: 383 }, () => 0)] },
				index: new LocalVectorIndex(384),
			},
		};
		const response = await handleApi(localEnv, new Request("https://anansi.test/api/ai", {
			method: "PATCH",
			headers: { authorization: "Bearer library-test-token", "content-type": "application/json" },
			body: JSON.stringify({ autoTaggingEnabled: true }),
		}));
		expect(response.status).toBe(400);
		await setAiSettings(db, { semanticSearchEnabled: false, autoTaggingEnabled: false });
	});

	test("GET /api/items/:id returns the full item, never raw", async () => {
		const list = await readJson(get("/api/items?limit=1"));
		const item = await readJson(get(`/api/items/${list.items[0].id}`));
		expect(item.url).toStartWith("https://");
		expect(item).not.toHaveProperty("raw");
	});

	test("GET /api/items/:id 404s for an unknown id", async () => {
		expect((await get("/api/items/does-not-exist")).status).toBe(404);
	});

	test("GET /api/creators is a group-by", async () => {
		const body = await readJson(get("/api/creators?limit=3"));
		expect(body.creators[0].saves).toBeGreaterThanOrEqual(
			body.creators[1].saves,
		);
	});

	test("POST /api/ingest refuses without the bearer token", async () => {
		const res = await handleApi(
			env,
			new Request("https://anansi.test/api/ingest", {
				method: "POST",
				body: JSON.stringify({ items: [] }),
			}),
		);
		expect(res.status).toBe(401);
	});

	test("POST /api/ingest is closed entirely when no token is configured", async () => {
		const res = await handleApi(
			{ db },
			new Request("https://anansi.test/api/ingest", {
				method: "POST",
				headers: { authorization: "Bearer test-token" },
				body: JSON.stringify({ items: [] }),
			}),
		);
		expect(res.status).toBe(503);
	});

	test("versioned ingest requires auth and a matching idempotency key", async () => {
		const capture = {
			schemaVersion: 1,
			payloadType: "item_event",
			eventId: "api-web-save-1",
			source: "web",
			action: "save",
			externalId: "sha256:api-web-save-1",
			canonicalUrl: "https://example.com/durable-bookmarks",
			observedAt: 1_788_390_100,
			captureMethod: "toolbar",
			normalizedItem: {
				source: "web",
				externalId: "sha256:api-web-save-1",
				url: "https://example.com/durable-bookmarks",
				kind: "article",
				body: "Durable bookmarks",
				savedAt: 1_788_390_100,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		};
		const send = (authorization?: string, idempotencyKey?: string) =>
			handleApi(
				env,
				new Request("https://anansi.test/api/ingest", {
					method: "POST",
					headers: {
						...(authorization ? { authorization } : {}),
						...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
						"content-type": "application/json",
					},
					body: JSON.stringify(capture),
				}),
			);

		expect((await send()).status).toBe(401);
		expect((await send("Bearer test-token", "wrong-event")).status).toBe(400);

		const first = await send("Bearer test-token", capture.eventId);
		const firstBody = await readJson(first);
		const replay = await send("Bearer test-token", capture.eventId);
		expect(first.status).toBe(200);
		expect(firstBody).toMatchObject({
			eventId: capture.eventId,
			outcome: "created",
		});
		expect(await readJson(replay)).toEqual(firstBody);
	});

	test("extension config accepts the ingest credential and names the ingest url", async () => {
		const body = await readJson(get("/api/extension/config"));
		expect(body.version).toBe(1);
		expect(body.enabled).toBe(true);
		expect(body.ingest).toEndWith("/api/ingest");
		expect(body.sources[0].operation).toBe("Bookmarks");
		expect(body.ingestProtocolVersion).toBe(2);
		// Web is on because it has no legacy path to conflict with. X is on for
		// acceptance testing; GitHub and Reddit remain staged until each has been
		// through the same pass.
		expect(body.features.captureV2).toEqual({
			x: true,
			reddit: true,
			web: true,
			github: true,
		});
		expect(body.features.chromeBookmarks).toBe(true);
		const github = body.sources.find(
			(source: { source: string }) => source.source === "github",
		);
		expect(github).toMatchObject({
			mode: "page",
			host: "github.com",
			url: "https://github.com/stars",
		});
	});

	test("extension heartbeat requires auth and updates connection health", async () => {
		const heartbeat = {
			schemaVersion: 1,
			installationId: "123e4567-e89b-42d3-a456-426614174000",
			extensionVersion: "0.1.0",
			queue: { queued: 1, uploading: 0, retrying: 0, failed: 0 },
			sources: {
				x: {
					phase: "idle",
					queued: 1,
					uploading: 0,
					retrying: 0,
					failed: 0,
				},
			},
		};
		const send = (body: unknown, authorized = true) =>
			handleApi(
				env,
				new Request("https://anansi.test/api/extension/heartbeat", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(authorized ? { authorization: "Bearer test-token" } : {}),
					},
					body: JSON.stringify(body),
				}),
			);

		expect((await send(heartbeat, false)).status).toBe(401);
		expect((await send({ ...heartbeat, token: "must-not-pass" })).status).toBe(
			400,
		);
		expect((await send(heartbeat)).status).toBe(200);

		const sources = await readJson(get("/api/sources"));
		expect(sources.extension).toMatchObject({
			connection: "connected",
			extensionVersion: "0.1.0",
			activeClients: 1,
		});
		expect(sources.sources).toHaveLength(4);
		expect(
			sources.sources.map((source: { source: string; mode: string }) => [
				source.source,
				source.mode,
			]),
		).toEqual([
			["x", "page"],
			["reddit", "session"],
			["web", "manual"],
			["github", "session"],
		]);
		expect(
			sources.sources.find(
				(source: { source: string }) => source.source === "github",
			),
		).toMatchObject({
			support: "supported",
			toggleable: true,
		});
	});

	test("GitHub can be toggled while unknown sources are rejected", async () => {
		const github = await handleApi(
			env,
			new Request("https://anansi.test/api/sources/github", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			}),
		);
		expect(github.status).toBe(200);
		expect(await readJson(github)).toEqual({
			source: "github",
			enabled: false,
		});

		const unknown = await handleApi(
			env,
			new Request("https://anansi.test/api/sources/unknown", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			}),
		);
		expect(unknown.status).toBe(400);
	});

	test("ingest parses a raw payload server-side", async () => {
		const raw = {
			data: {
				bookmark_timeline_v2: {
					timeline: {
						instructions: [
							{
								entries: ["1001", "1002"].map((id, index) => ({
									entryId: `tweet-${id}`,
									sortIndex: String(2 - index),
									content: {
										itemContent: {
											tweet_results: {
												result: {
													rest_id: id,
													core: {
														user_results: {
															result: {
																legacy: {
																	screen_name: `user-${id}`,
																	name: `User ${id}`,
														},
													},
												},
													},
													legacy: {
														full_text: `Fixture ${id}`,
														created_at: "Wed Sep 01 00:00:00 +0000 2021",
														entities: { urls: [] },
													},
												},
											},
										},
									},
								})),
							},
						],
					},
				},
			},
		};
		const res = await handleApi(
			env,
			new Request("https://anansi.test/api/ingest", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ source: "x", raw }),
			}),
		);
		expect(res.status).toBe(200);
		expect((await readJson(res)).parsed).toBe(2);
	});

	test("a raw payload that parses to nothing is an error, not a cheerful zero", async () => {
		const res = await handleApi(
			env,
			new Request("https://anansi.test/api/ingest", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ source: "x", raw: { data: {} } }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("unknown routes 404", async () => {
		expect((await get("/api/nope")).status).toBe(404);
	});
});

describe("repeated filter params", () => {
	beforeAll(async () => {
		await upsertItems(db, [
			{
				source: "reddit",
				externalId: "r-1",
				url: "https://www.reddit.com/r/x/comments/r1/",
				kind: "post",
				authorHandle: "redditor",
				body: "a reddit save",
				postedAt: 1_788_380_000,
				savedAt: 1_788_380_000,
				savedAtIsExact: false,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
			{
				source: "github",
				externalId: "g-1",
				url: "https://github.com/anansi/anansi",
				kind: "repo",
				authorHandle: "anansi",
				body: "a starred repo",
				postedAt: 1_788_370_000,
				savedAt: 1_788_370_000,
				savedAtIsExact: true,
				metrics: {},
				media: [],
				links: [],
				raw: {},
			},
		]);
	});

	test("?source=a&source=b returns both, not neither", async () => {
		const body = await readJson(
			get("/api/items?source=reddit&source=github&limit=50"),
		);
		const sources = [...new Set(body.items.map((i: any) => i.source))].sort();

		expect(sources).toEqual(["github", "reddit"]);
	});

	test("the first value is not the only one used", async () => {
		// github alone matches one item; if only the first param were read this
		// would return that one item rather than both.
		const body = await readJson(
			get("/api/items?source=github&source=reddit&limit=50"),
		);

		expect(body.items.length).toBe(2);
	});

	test("one value still behaves exactly as before", async () => {
		const body = await readJson(get("/api/items?source=reddit&limit=50"));

		expect(body.items.length).toBe(1);
		expect(body.items[0].source).toBe("reddit");
	});

	test("no filter param is no filter, not an empty library", async () => {
		const body = await readJson(get("/api/items?limit=50"));

		expect(body.items.length).toBeGreaterThan(12);
	});

	test("content types are ORed across the wire too", async () => {
		const body = await readJson(
			get("/api/items?type=repo&type=comment&limit=50"),
		);

		expect(body.items.map((i: any) => i.source)).toEqual(["github"]);
	});

	test("favorite is applied by both list and search HTTP routes", async () => {
		const all = await readJson(get("/api/items?source=reddit&limit=10"));
		const id = all.items[0].id as string;
		const changed = await handleApi(env, new Request(`https://anansi.test/api/items/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ favorite: true }),
		}));
		expect(changed.status).toBe(200);
		const listed = await readJson(get("/api/items?favorite=1&limit=50"));
		expect(listed.items.map((item: { id: string }) => item.id)).toContain(id);
		expect(listed.items.every((item: { favorite: boolean }) => item.favorite)).toBe(true);
		const searched = await readJson(get("/api/search?q=reddit&favorite=1&limit=50"));
		expect(searched.items.map((item: { id: string }) => item.id)).toEqual([id]);
	});

	test("a hostile value is bound, not interpolated", async () => {
		const hostile = encodeURIComponent("x') or 1=1 --");
		const res = await get(
			`/api/items?source=reddit&source=${hostile}&limit=50`,
		);

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).items.length).toBe(1);
	});
});
