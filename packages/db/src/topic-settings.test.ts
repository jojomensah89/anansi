import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { publishAiTags } from "./ai-bulk.ts";
import { removeItemTag } from "./organization.ts";
import { listTags, tagItems, upsertItems } from "./queries.ts";
import { aiEnrichmentJobs, itemTags, items, tags } from "./schema.ts";
import { openTestDb } from "./test-db.ts";
import {
	TOPIC_LIMIT, activeTopics, createTopic, deleteTopic, listTopics, requeueTagging, resolveTopicIds, topicSettings, updateTopic,
} from "./topic-settings.ts";
import { TOPIC_DEFINITIONS } from "./topics.ts";
import type { AnansiDb } from "./types.ts";

async function oneSave(db: AnansiDb, externalId = "a"): Promise<string> {
	await upsertItems(db, [{ source: "web", externalId, url: `https://example.com/${externalId}`, kind: "article", title: externalId, body: "b", savedAt: 1, savedAtIsExact: true, media: [], metrics: {}, raw: {}, links: [] }]);
	return (await db.select().from(items).where(eq(items.externalId, externalId)))[0]!.id;
}

/** Publish AI topics for one save the way the drain does: through a held job. */
async function publish(db: AnansiDb, itemId: string, topicIds: string[], keep: string[] = []) {
	const token = crypto.randomUUID();
	const jobId = `tagging:m:${itemId}:${token}`;
	await db.insert(aiEnrichmentJobs).values({ id: jobId, itemId, kind: "tagging", contentHash: "h", status: "running", claimToken: token, leaseUntil: 9_999_999_999 });
	const all = await listTopics(db);
	await publishAiTags(db, [{ jobId, itemId, topics: topicIds.map((id) => all.find((topic) => topic.id === id)!) }], "m", token, undefined, keep);
}

const tagIdsOn = async (db: AnansiDb, itemId: string) => (await db.select().from(itemTags).where(eq(itemTags.itemId, itemId))).map((row) => row.tagId).sort();

describe("owner topic list", () => {
	test("starts as the built-in list, all on", async () => {
		const db = openTestDb();
		const topics = await topicSettings(db);
		expect(topics.map((topic) => topic.id)).toEqual(TOPIC_DEFINITIONS.map((topic) => topic.id));
		expect(topics.every((topic) => topic.builtIn && topic.enabled && topic.count === 0)).toBe(true);
	});

	test("built-ins switch off and on and take a new description, reset with null", async () => {
		const db = openTestDb();
		await updateTopic(db, "gaming", { enabled: false });
		await updateTopic(db, "music", { description: "Only vinyl and turntables." });
		expect((await activeTopics(db)).some((topic) => topic.id === "gaming")).toBe(false);
		expect((await listTopics(db)).find((topic) => topic.id === "music")).toMatchObject({ description: "Only vinyl and turntables.", enabled: true });
		await updateTopic(db, "music", { description: null });
		expect((await listTopics(db)).find((topic) => topic.id === "music")?.description).toBe(TOPIC_DEFINITIONS.find((topic) => topic.id === "music")!.description);
		await updateTopic(db, "gaming", { enabled: true });
		expect((await activeTopics(db)).length).toBe(TOPIC_DEFINITIONS.length);
		await expect(updateTopic(db, "gaming", { description: "x".repeat(161) })).rejects.toThrow("160");
		await expect(deleteTopic(db, "gaming")).rejects.toThrow("turned off");
		await expect(updateTopic(db, "nope", { enabled: false })).rejects.toThrow("No such topic");
	});

	test("custom topics get custom- ids and a topic tag, and names must be free", async () => {
		const db = openTestDb();
		const rust = await createTopic(db, { label: "Rust", description: "The Rust programming language and its crates." });
		expect(rust).toMatchObject({ id: "custom-rust", tagId: "topic:custom-rust", builtIn: false, enabled: true });
		expect(await db.select().from(tags).where(eq(tags.id, "topic:custom-rust"))).toMatchObject([{ label: "Rust", kind: "topic", origin: "ai" }]);
		expect((await listTags(db)).find((tag) => tag.label === "Rust")?.kind).toBe("topic");
		await expect(createTopic(db, { label: "rust" })).rejects.toThrow("already a topic");
		await expect(createTopic(db, { label: "Gaming" })).rejects.toThrow("already a topic");
		await expect(createTopic(db, { label: "anime" })).rejects.toThrow("already a topic");
		await expect(createTopic(db, { label: "x".repeat(33) })).rejects.toThrow("32");
		await expect(createTopic(db, { label: "Ok", description: "y".repeat(161) })).rejects.toThrow("160");
		const id = await oneSave(db);
		await tagItems(db, [id], "cooking club");
		await expect(createTopic(db, { label: "Cooking Club" })).rejects.toThrow("tag named");
		// Tagging by hand finds the topic whatever the capitals.
		await tagItems(db, [id], "rust");
		expect(await tagIdsOn(db, id)).toContain("topic:custom-rust");
		await removeItemTag(db, id, "rust");
		expect(await tagIdsOn(db, id)).not.toContain("topic:custom-rust");
	});

	test("at most forty topics can be on", async () => {
		const db = openTestDb();
		for (let n = TOPIC_DEFINITIONS.length; n < TOPIC_LIMIT; n++) await createTopic(db, { label: `Topic ${n}` });
		await expect(createTopic(db, { label: "One too many" })).rejects.toThrow(String(TOPIC_LIMIT));
		await updateTopic(db, "gaming", { enabled: false });
		await createTopic(db, { label: "Fits now" });
		await expect(updateTopic(db, "gaming", { enabled: true })).rejects.toThrow(String(TOPIC_LIMIT));
	});

	test("switching a topic off keeps its tags; retagging leaves them in place", async () => {
		const db = openTestDb();
		const id = await oneSave(db);
		await publish(db, id, ["gaming", "music"]);
		await updateTopic(db, "gaming", { enabled: false });
		expect(await tagIdsOn(db, id)).toEqual(["topic:gaming", "topic:music"]);
		const disabled = (await listTopics(db)).filter((topic) => !topic.enabled).map((topic) => topic.tagId);
		await publish(db, id, ["science"], disabled);
		expect(await tagIdsOn(db, id)).toEqual(["topic:gaming", "topic:science"]);
	});

	test("deleting a custom topic removes AI tags but keeps the owner's own", async () => {
		const db = openTestDb();
		const a = await oneSave(db, "a");
		const b = await oneSave(db, "b");
		await createTopic(db, { label: "Rust" });
		await publish(db, a, ["custom-rust"]);
		await tagItems(db, [b], "Rust");
		expect((await topicSettings(db)).find((topic) => topic.id === "custom-rust")?.count).toBe(2);
		await deleteTopic(db, "custom-rust");
		expect(await tagIdsOn(db, a)).toEqual([]);
		expect(await tagIdsOn(db, b)).toEqual(["topic:custom-rust"]);
		expect(await db.select().from(tags).where(eq(tags.id, "topic:custom-rust"))).toMatchObject([{ kind: "custom", origin: "manual" }]);
		expect((await listTopics(db)).some((topic) => topic.id === "custom-rust")).toBe(false);

		await createTopic(db, { label: "Zig" });
		await publish(db, a, ["custom-zig"]);
		await deleteTopic(db, "custom-zig");
		expect(await db.select().from(tags).where(eq(tags.id, "topic:custom-zig"))).toEqual([]);
	});

	test("retag reopens every tagging job and nothing else", async () => {
		const db = openTestDb();
		const a = await oneSave(db, "a");
		await db.insert(aiEnrichmentJobs).values([
			{ id: "tagging:m:a", itemId: a, kind: "tagging", contentHash: "h", status: "complete", attempts: 2 },
			{ id: "tagging:m:b", itemId: a, kind: "tagging", contentHash: "h2", status: "failed", lastError: "ai:malformed" },
			{ id: "embedding:m:a", itemId: a, kind: "embedding", contentHash: "h", status: "complete" },
		]);
		expect(await requeueTagging(db)).toBe(2);
		const jobs = await db.select().from(aiEnrichmentJobs);
		expect(jobs.filter((job) => job.kind === "tagging").every((job) => job.status === "pending" && job.attempts === 0 && job.lastError === null)).toBe(true);
		expect(jobs.find((job) => job.kind === "embedding")?.status).toBe("complete");
	});

	test("model output maps onto the given topics only", () => {
		const topics = [{ id: "web-dev", label: "Web Dev" }, { id: "custom-rust", label: "Rust" }];
		expect(resolveTopicIds(["rust", "javascript", "AI / ML", "custom-rust", "Web Dev"], topics)).toEqual(["custom-rust", "web-dev"]);
	});
});
