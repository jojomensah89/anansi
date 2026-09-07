import { describe, expect, test } from "bun:test";
import { TOPIC_DEFINITIONS, TOPIC_TAXONOMY_VERSION, canonicalTopicId, canonicalizeTopicIds } from "./topics.ts";
import { openTestDb } from "./test-db.ts";
import { tags } from "./schema.ts";

describe("canonical AI topics", () => {
	test("exposes a stable v1 vocabulary", () => {
		expect(TOPIC_TAXONOMY_VERSION).toBe("v1");
		expect(TOPIC_DEFINITIONS.map((topic) => topic.id)).toEqual([
			"web-dev", "ai-ml", "marketing", "design", "startups", "product", "career", "devops", "security", "finance", "health",
		]);
	});

	test("maps approved aliases and rejects noisy multilingual labels", () => {
		expect(canonicalTopicId("Web Development")).toBe("web-dev");
		expect(canonicalTopicId("machine learning")).toBe("ai-ml");
		expect(canonicalTopicId("강성지도")).toBeUndefined();
		expect(canonicalTopicId("教育暗箱")).toBeUndefined();
		expect(canonicalTopicId("random one-off phrase")).toBeUndefined();
	});

	test("deduplicates and caps topics", () => {
		expect(canonicalizeTopicIds(["web-dev", "Web Dev", "ai-ml", "design", "finance"], 3)).toEqual(["web-dev", "ai-ml", "design"]);
		expect(canonicalizeTopicIds(["not-a-topic", 4, null])).toEqual([]);
	});

	test("migration seeds canonical topic rows", async () => {
		const db = openTestDb();
		const topicRows = (await db.select().from(tags)).filter((tag) => tag.kind === "topic");
		expect(topicRows.map((tag) => tag.label).sort()).toEqual(TOPIC_DEFINITIONS.map((topic) => topic.label).sort());
	});
});
