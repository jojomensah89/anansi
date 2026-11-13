import { describe, expect, test } from "bun:test";
import { TOPIC_DEFINITIONS, aiEnrichmentJobs, createTopic, itemTags, items, setAiSettings, tagItems, updateTopic, upsertItems, type AnansiDb } from "@anansi/db";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { CLEF_CALLS_PER_PASS, clefSavesPerCall, generateTagsBatch, tagPassLimit } from "./ai.ts";
import { drainAi } from "./ai-drain.ts";
import { handleApi } from "./api.ts";

const CLEF = "@cf/cloudflare/clef-flash";
const save = (index: number) => ({ source: "web", externalId: `s-${index}`, url: `https://example.com/${index}`, kind: "article", title: `Save ${index}`, body: `lighthouse ${index}`, savedAt: index + 1, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} });

function api(db: AnansiDb, extra: Record<string, unknown> = {}) {
	const env = { db, libraryToken: "secret", ...extra };
	return async (method: string, path: string, body?: unknown) => {
		const response = await handleApi(env, new Request(`https://anansi.test${path}`, {
			method, headers: { authorization: "Bearer secret", ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		}));
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
}

async function library(count = 4) {
	const db = openTestDb();
	await upsertItems(db, Array.from({ length: count }, (_, index) => save(index)));
	const ids = (await db.select({ id: items.id, externalId: items.externalId }).from(items)).sort((a, b) => a.externalId.localeCompare(b.externalId)).map((row) => row.id);
	return { db, ids, call: api(db) };
}

describe("shelves API", () => {
	test("create, list with counts, filter the library, and patch", async () => {
		const { db, ids, call } = await library();
		await tagItems(db, [ids[0]!, ids[1]!], "reading");
		const created = await call("POST", "/api/shelves", { name: "Reading", color: "sky", icon: "book-open", filters: { tag: ["reading"] } });
		expect(created.status).toBe(200);
		expect(created.body.shelf).toMatchObject({ name: "Reading", color: "sky", icon: "book-open", position: 0, count: 2, filters: { tag: ["reading"] } });
		const id = created.body.shelf.id as string;

		expect((await call("POST", "/api/shelves", { name: "Bad", color: "#fff" })).status).toBe(400);
		expect((await call("POST", "/api/shelves", { color: "red" })).status).toBe(400);

		const listed = await call("GET", "/api/shelves");
		expect(listed.body.shelves.map((shelf: { id: string; count: number }) => [shelf.id, shelf.count])).toEqual([[id, 2]]);

		const page = await call("GET", `/api/items?shelf=${id}`);
		expect(page.body.items.map((item: { id: string }) => item.id).sort()).toEqual([ids[0], ids[1]].sort());
		expect((await call("GET", "/api/items?shelf=missing")).status).toBe(404);
		const search = await call("GET", `/api/search?q=lighthouse&shelf=${id}`);
		expect(search.body.items.map((item: { id: string }) => item.id).sort()).toEqual([ids[0], ids[1]].sort());

		const patched = await call("PATCH", `/api/shelves/${id}`, { name: "Later", color: null });
		expect(patched.body.shelf).toMatchObject({ name: "Later", color: null, icon: "book-open" });
		expect((await call("PATCH", "/api/shelves/missing", { name: "x" })).status).toBe(404);
	});

	test("items on and off a shelf, item detail shelves, reorder, delete and the collections alias", async () => {
		const { db, ids, call } = await library();
		await tagItems(db, [ids[0]!], "reading");
		const ruled = (await call("POST", "/api/shelves", { name: "Reading", filters: { tag: ["reading"] } })).body.shelf;
		const picked = (await call("POST", "/api/shelves", { name: "Picks" })).body.shelf;

		const added = await call("POST", `/api/shelves/${picked.id}/items`, { itemIds: [ids[1], ids[2]], action: "add" });
		expect(added.body).toMatchObject({ changed: 2, shelf: { id: picked.id, count: 2 } });
		const removed = await call("POST", `/api/shelves/${ruled.id}/items`, { itemIds: [ids[0]], action: "remove" });
		expect(removed.body.shelf.count).toBe(0);
		expect((await call("POST", `/api/shelves/${ruled.id}/items`, { itemIds: [ids[0]], action: "move" })).status).toBe(400);
		expect((await call("POST", "/api/shelves/missing/items", { itemIds: [ids[0]], action: "add" })).status).toBe(404);

		expect((await call("GET", `/api/items/${ids[1]}`)).body.shelves).toEqual([picked.id]);
		expect((await call("GET", `/api/items/${ids[0]}`)).body.shelves).toEqual([]);

		const reordered = await call("POST", "/api/shelves/reorder", { ids: [picked.id, ruled.id] });
		expect(reordered.body.shelves.map((shelf: { id: string; position: number }) => [shelf.id, shelf.position])).toEqual([[picked.id, 0], [ruled.id, 1]]);
		expect((await call("POST", "/api/shelves/reorder", { ids: "nope" })).status).toBe(400);

		const legacy = await call("GET", "/api/collections");
		expect(legacy.body.collections.map((row: { id: string }) => row.id)).toEqual([picked.id, ruled.id]);
		expect((await call("POST", "/api/collections", { name: "Old", filters: {} })).status).toBe(200);

		expect((await call("DELETE", `/api/shelves/${picked.id}`)).body).toEqual({ deleted: true });
		expect((await call("DELETE", `/api/shelves/${picked.id}`)).status).toBe(404);
		expect((await db.select().from(items)).length).toBe(4);
	});

	test("suggestions and dismissal", async () => {
		const { db, ids, call } = await library(20);
		await tagItems(db, ids, "Gaming");
		expect((await call("GET", "/api/shelves/suggestions")).body.suggestions).toEqual([{ topic: "gaming", label: "Gaming", count: 20, filters: { tag: ["Gaming"] } }]);
		expect((await call("POST", "/api/shelves/suggestions/dismiss", {})).status).toBe(400);
		expect((await call("POST", "/api/shelves/suggestions/dismiss", { topic: "gaming" })).body).toEqual({ dismissed: true });
		expect((await call("GET", "/api/shelves/suggestions")).body.suggestions).toEqual([]);
	});

	test("shelf writes need the owner", async () => {
		const { db } = await library(1);
		const anonymous = await handleApi({ db, libraryToken: "secret" }, new Request("https://anansi.test/api/shelves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) }));
		expect(anonymous.status).toBe(401);
	});
});

describe("topics API", () => {
	test("list, add, edit, switch off, delete; changes never retag by themselves", async () => {
		const { db, ids, call } = await library(1);
		await db.insert(aiEnrichmentJobs).values({ id: "tagging:m:x", itemId: ids[0]!, kind: "tagging", contentHash: "h", status: "complete" });
		const listed = await call("GET", "/api/ai/topics");
		expect(listed.body.limit).toBe(40);
		expect(listed.body.topics).toHaveLength(TOPIC_DEFINITIONS.length);
		expect(listed.body.topics[0]).toMatchObject({ id: "web-dev", label: "Web Dev", builtIn: true, enabled: true, count: 0 });

		const added = await call("POST", "/api/ai/topics", { label: "Rust", description: "The Rust language." });
		expect(added.body.topics.at(-1)).toMatchObject({ id: "custom-rust", label: "Rust", description: "The Rust language.", builtIn: false, enabled: true });
		expect((await call("POST", "/api/ai/topics", { label: "Rust" })).status).toBe(409);
		expect((await call("POST", "/api/ai/topics", { label: "" })).status).toBe(400);

		const off = await call("PATCH", "/api/ai/topics/gaming", { enabled: false, description: "Board games only." });
		expect(off.body.topics.find((topic: { id: string }) => topic.id === "gaming")).toMatchObject({ enabled: false, description: "Board games only." });
		expect((await call("PATCH", "/api/ai/topics/gaming", { enabled: "no" })).status).toBe(400);
		expect((await call("PATCH", "/api/ai/topics/nope", { enabled: true })).status).toBe(404);
		expect((await call("DELETE", "/api/ai/topics/gaming")).status).toBe(400);
		expect((await call("DELETE", "/api/ai/topics/custom-rust")).body.topics.some((topic: { id: string }) => topic.id === "custom-rust")).toBe(false);

		expect((await db.select().from(aiEnrichmentJobs))[0]?.status).toBe("complete");
		expect((await call("POST", "/api/ai/retag", {})).body).toEqual({ queued: 1 });
		expect((await db.select().from(aiEnrichmentJobs))[0]?.status).toBe("pending");
	});
});

describe("Clef with the owner's topics", () => {
	test("questions come from the effective list and packing follows its size", async () => {
		const calls: Array<{ questions: Record<string, { instructions: string }> }> = [];
		const ai = { run: async (_model: string, input: unknown) => {
			const request = input as { questions: Record<string, { instructions: string }> };
			calls.push(request);
			return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: id.endsWith("custom-rust") ? 0.9 : 0.1 }])) };
		} };
		const topics = Array.from({ length: 30 }, (_, n) => ({ id: n === 0 ? "custom-rust" : `custom-t${n}`, label: n === 0 ? "Rust" : `T${n}`, description: n === 0 ? "Crates and cargo." : "" }));
		expect(clefSavesPerCall(30)).toBe(2);
		expect(clefSavesPerCall(40)).toBe(1);
		expect(clefSavesPerCall(100)).toBe(1);
		const tags = await generateTagsBatch(ai, CLEF, ["a", "b", "c", "d", "e"], 3, topics);
		expect(calls.map((call) => Object.keys(call.questions).length)).toEqual([60, 60, 30]);
		expect(calls[0]!.questions["s1.custom-rust"]).toEqual({ type: "noul", instructions: "Is save s1 mainly about Rust? Crates and cargo." } as never);
		expect(tags).toEqual([["custom-rust"], ["custom-rust"], ["custom-rust"], ["custom-rust"], ["custom-rust"]]);
		expect(await generateTagsBatch(ai, CLEF, ["a"], 3, [])).toEqual([[]]);
	});

	test("a tagging pass stays inside the Clef call budget, whatever the topic count", async () => {
		expect(tagPassLimit(CLEF, 19, 40)).toBe(40);
		expect(tagPassLimit(CLEF, 30, 40)).toBe(28);
		expect(tagPassLimit(CLEF, 40, 40)).toBe(CLEF_CALLS_PER_PASS);
		expect(tagPassLimit(CLEF, 40, 5)).toBe(5);
		expect(tagPassLimit("@cf/meta/llama", 40, 40)).toBe(40);
		const db = openTestDb();
		await upsertItems(db, Array.from({ length: 60 }, (_, index) => save(index)));
		await setAiSettings(db, { autoTaggingEnabled: true });
		for (let n = TOPIC_DEFINITIONS.length; n < 40; n++) await createTopic(db, { label: `Topic ${n}` });
		let calls = 0;
		const ai = { run: async (_model: string, input: unknown) => {
			calls += 1;
			const request = input as { questions: Record<string, unknown> };
			return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 0.1 }])) };
		} };
		for (let pass = 0; pass < 3; pass++) {
			calls = 0;
			const result = await drainAi(db, { ai });
			expect(calls).toBeLessThanOrEqual(CLEF_CALLS_PER_PASS);
			expect(result.claimed).toBe(CLEF_CALLS_PER_PASS);
		}
	});

	test("a drain asks about enabled topics with edited descriptions, adds custom tags and keeps switched-off ones", async () => {
		const db = openTestDb();
		await upsertItems(db, [save(0)]);
		await setAiSettings(db, { autoTaggingEnabled: true });
		const [item] = await db.select().from(items);
		await db.insert(itemTags).values({ itemId: item!.id, tagId: "topic:gaming", provenance: "ai", model: "old" });
		await updateTopic(db, "gaming", { enabled: false });
		await updateTopic(db, "music", { description: "Vinyl only." });
		await createTopic(db, { label: "Lighthouses", description: "Coastal towers." });
		const questions: Record<string, { instructions: string }>[] = [];
		const ai = { run: async (_model: string, input: unknown) => {
			const request = input as { questions: Record<string, { instructions: string }> };
			questions.push(request.questions);
			return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: id === "custom-lighthouses" ? 0.9 : 0.1 }])) };
		} };
		expect((await drainAi(db, { ai })).processed).toBe(1);
		const asked = Object.keys(questions[0]!);
		expect(asked).toHaveLength(TOPIC_DEFINITIONS.length);
		expect(asked).not.toContain("gaming");
		expect(asked).toContain("custom-lighthouses");
		expect(questions[0]!.music!.instructions).toBe("Is this save mainly about Music? Vinyl only.");
		expect((await db.select().from(itemTags)).map((row) => row.tagId).sort()).toEqual(["topic:custom-lighthouses", "topic:gaming"]);
	});
});
