import { expect, test } from "bun:test";
import { type AnansiDb, aiEnrichmentJobs, aiProgress, claimDueAiJobs, insertClaimedAiJobs, itemTags, reconcileAiJobs, semanticChunks, semanticIndexStats, setAiSettings, upsertItems } from "@anansi/db";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { CLEF_SAVES_PER_CALL, generateTagsBatch } from "./ai.ts";
import { TAG_DRAIN_LIMIT, drainAi } from "./ai-drain.ts";
import { handleApi } from "./api.ts";

const CLEF = "@cf/cloudflare/clef-flash";
const save = (index: number, body = "Software development") => ({ source: "web", externalId: `drain-${index}`, url: `https://example.com/${index}`, kind: "article", body, savedAt: index + 1, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} });
const seed = (db: AnansiDb, count: number) => upsertItems(db, Array.from({ length: count }, (_, index) => save(index)));

type ClefInput = { state: unknown; questions: Record<string, unknown> };
/** Answers every packed or single question: yes for web-dev, no for the rest. */
function clef(calls: ClefInput[] = []) {
	return {
		calls,
		run: async (_model: string, input: unknown) => {
			const request = input as ClefInput;
			calls.push(request);
			if (!request.questions) return { data: (request as unknown as { text: string[] }).text.map(() => Array.from({ length: 384 }, () => 0.1)) };
			return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: id.endsWith("web-dev") ? 0.9 : 0.1 }])) };
		},
	};
}

/** Counts statements the way D1 counts queries: one per prepared statement run. */
function countQueries(db: AnansiDb) {
	const client = (db as unknown as { $client: { prepare: (...args: unknown[]) => unknown; query: (...args: unknown[]) => unknown } }).$client;
	const counter = { count: 0 };
	for (const method of ["prepare", "query"] as const) {
		const original = client[method].bind(client);
		client[method] = (...args: unknown[]) => { counter.count += 1; return original(...args); };
	}
	return counter;
}

test("packs five saves into one Clef request and reads each save's answers", async () => {
	expect(CLEF_SAVES_PER_CALL).toBe(5);
	const calls: ClefInput[] = [];
	const ai = {
		run: async (_model: string, input: unknown) => {
			const request = input as ClefInput;
			calls.push(request);
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(request.questions)) answers[id] = { noul: 0.1 };
			Object.assign(answers, { "s0.design": { noul: 0.8 }, "s0.ai-ml": { noul: 0.95 }, "s0.security": 0.6, "s0.finance": { noul: 0.55 }, "s2.health": { noul: 0.7 } });
			return { answers };
		},
	};
	const tags = await generateTagsBatch(ai, CLEF, ["a", "b", "c", "d", "e", "f", "g"]);
	expect(calls.map((call) => Object.keys(call.questions).length)).toEqual([55, 22]);
	expect(calls[0]!.state).toEqual(["a", "b", "c", "d", "e"].map((text, index) => ({ id: `s${index}`, text })));
	expect(calls[0]!.questions["s1.design"]).toEqual({ type: "noul", instructions: "Is save s1 mainly about Design?" });
	// Three likeliest at one half or above; a save with none has no tags.
	expect(tags.slice(0, 3)).toEqual([["ai-ml", "design", "security"], [], ["health"]]);
});

test("asks again one save at a time when a packed answer cannot be read", async () => {
	const calls: ClefInput[] = [];
	const ai = {
		run: async (_model: string, input: unknown) => {
			const request = input as ClefInput;
			calls.push(request);
			if (Array.isArray(request.state)) {
				// Save s1 comes back unreadable; s0 is fine.
				return { answers: Object.fromEntries(Object.keys(request.questions).filter((id) => id.startsWith("s0.")).map((id) => [id, { noul: id === "s0.design" ? 0.9 : 0 }])) };
			}
			return { answers: { finance: { noul: 0.9 }, design: { noul: 0.2 } } };
		},
	};
	expect(await generateTagsBatch(ai, CLEF, ["first", "second"])).toEqual([["design"], ["finance"]]);
	expect(calls).toHaveLength(2);
	expect(calls[1]!.state).toBe("second");

	// A packed request the provider rejects outright falls back for every save.
	let packed = 0;
	const rejecting = { run: async (_model: string, input: unknown) => { if (Array.isArray((input as ClefInput).state)) { packed += 1; throw new Error("state must be a string"); } return { answers: { design: { noul: 0.9 } } }; } };
	expect(await generateTagsBatch(rejecting, CLEF, ["first", "second"])).toEqual([["design"], ["design"]]);
	expect(packed).toBe(1);

	// Out of quota is reported, not retried save by save.
	let quotaCalls = 0;
	const exhausted = { run: async () => { quotaCalls += 1; throw new Error("429 quota exceeded"); } };
	const refused = await generateTagsBatch(exhausted, CLEF, ["first", "second"]);
	expect(refused.map((entry) => (entry as { code?: string }).code)).toEqual(["quota", "quota"]);
	expect(quotaCalls).toBe(1);
});

test("a tagging pass handles forty saves inside the free-plan query budget", async () => {
	const db = openTestDb();
	await seed(db, 100);
	await setAiSettings(db, { autoTaggingEnabled: true });
	const ai = clef();
	const queries = countQueries(db);
	const pass = await drainAi(db, { ai });
	expect(pass).toMatchObject({ kind: "tagging", processed: TAG_DRAIN_LIMIT, claimed: TAG_DRAIN_LIMIT });
	expect(ai.calls).toHaveLength(TAG_DRAIN_LIMIT / CLEF_SAVES_PER_CALL);
	// Settings, claim, unqueued, insert, tags, delete, item tags, complete.
	expect(queries.count).toBeLessThanOrEqual(10);
	expect(await aiProgress(db, "tagging")).toEqual({ complete: 40, pending: 60, failed: 0 });
	expect((await db.select().from(itemTags)).every((row) => row.tagId === "topic:web-dev" && row.provenance === "ai")).toBe(true);
	expect(await db.select().from(itemTags)).toHaveLength(40);

	// The whole HTTP request, auth and progress included, stays far below 50.
	queries.count = 0;
	const response = await handleApi({ db, libraryToken: "test", ai }, new Request("https://anansi.test/api/ai/drain", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: "{}" }));
	const body = await response.json() as { processed: number; pending: number; done: boolean; taggingProgress: { complete: number } };
	expect(body).toMatchObject({ processed: 40, pending: 20, done: false, taggingProgress: { complete: 80 } });
	expect(queries.count).toBeLessThanOrEqual(20);

	const last = await (await handleApi({ db, libraryToken: "test", ai }, new Request("https://anansi.test/api/ai/drain", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: "{}" }))).json() as { processed: number; pending: number; done: boolean };
	expect(last).toMatchObject({ processed: 20, pending: 0, done: true });
});

test("an indexing pass embeds a batch in one provider call inside the budget", async () => {
	const db = openTestDb();
	await seed(db, 30);
	await setAiSettings(db, { semanticSearchEnabled: true });
	const ai = clef();
	const upserts: number[] = [];
	const vectorize = { upsert: async (vectors: unknown[]) => { upserts.push(vectors.length); }, query: async () => ({ matches: [] }) };
	const queries = countQueries(db);
	const pass = await drainAi(db, { ai, vectorize });
	expect(pass).toMatchObject({ kind: "embedding", processed: 12, claimed: 12 });
	expect(ai.calls).toHaveLength(1);
	expect(upserts).toEqual([12]);
	expect(queries.count).toBeLessThanOrEqual(16);
	expect((await db.select().from(semanticChunks)).every((chunk) => chunk.status === "complete")).toBe(true);
	const settings = await setAiSettings(db, {});
	expect(await semanticIndexStats(db, settings.embeddingModel, settings.semanticGeneration)).toEqual({ indexed: 12, pending: 18, total: 30 });
});

test("two drains at once never take the same save", async () => {
	const db = openTestDb();
	await seed(db, 30);
	await setAiSettings(db, { autoTaggingEnabled: true });
	await reconcileAiJobs(db, 100);
	const settings = await setAiSettings(db, {});
	const [first, second] = await Promise.all([
		claimDueAiJobs(db, "tagging", settings.tagModel, 20, "tab-one"),
		claimDueAiJobs(db, "tagging", settings.tagModel, 20, "tab-two"),
	]);
	expect(first.length + second.length).toBe(30);
	expect(new Set([...first, ...second].map((job) => job.id)).size).toBe(30);
	// A job another caller already created is not handed out a second time.
	const taken = first[0]!;
	expect((await insertClaimedAiJobs(db, "tagging", [{ id: taken.id, itemId: taken.itemId, contentHash: taken.contentHash }], "tab-three")).size).toBe(0);

	const fresh = openTestDb();
	await seed(fresh, 60);
	await setAiSettings(fresh, { autoTaggingEnabled: true });
	const ai = clef();
	const passes = await Promise.all([drainAi(fresh, { ai }), drainAi(fresh, { ai })]);
	// Both saw the same forty unqueued saves; only one of them got each.
	expect(passes[0]!.processed + passes[1]!.processed).toBe(40);
	expect(await fresh.select().from(itemTags)).toHaveLength(40);
	expect((await drainAi(fresh, { ai })).processed).toBe(20);
	expect((await fresh.select().from(aiEnrichmentJobs)).filter((job) => job.status === "complete")).toHaveLength(60);
});

test("a save is tagged as it is ingested when tagging is on, and not when it is off", async () => {
	const db = openTestDb();
	const ai = clef();
	const env = { db, libraryToken: "secret", ingestToken: "secret", ai };
	const ingest = (index: number) => handleApi(env, new Request("https://anansi.test/api/ingest", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ items: [save(index)] }) }));

	expect((await ingest(0)).status).toBe(200);
	expect(ai.calls).toHaveLength(0);
	expect(await db.select().from(itemTags)).toHaveLength(0);

	await setAiSettings(db, { autoTaggingEnabled: true });
	expect((await ingest(1)).status).toBe(200);
	expect(ai.calls).toHaveLength(1);
	expect((await db.select().from(itemTags)).map((row) => row.tagId)).toEqual(["topic:web-dev", "topic:web-dev"]);
	expect(await aiProgress(db, "tagging")).toEqual({ complete: 2, pending: 0, failed: 0 });

	// A provider failure never fails the save itself.
	const broken = { ...env, ai: { run: async () => { throw new Error("provider down"); } } };
	const response = await handleApi(broken, new Request("https://anansi.test/api/ingest", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ items: [save(2)] }) }));
	expect(response.status).toBe(200);
});
