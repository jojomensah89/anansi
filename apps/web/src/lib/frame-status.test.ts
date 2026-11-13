import { expect, test } from "bun:test";
import type { AiSettingsResponse, ExtensionHealth } from "./api.ts";
import { aiJobs, extensionTitle, importJobs } from "./frame-status.ts";
import { topicColorIndex, TOPIC_PALETTE_SIZE } from "./tag-colors.ts";

const idle = { phase: "idle", queued: 0, uploading: 0, retrying: 0, failed: 0 } as const;
const extension = (sources: ExtensionHealth["sources"], connection: ExtensionHealth["connection"] = "connected"): ExtensionHealth => ({
	connection, extensionVersion: "1.0.25", lastSeenAt: 1, activeClients: 1, queue: { queued: 0, uploading: 0, retrying: 0, failed: 0 }, sources,
});

test("an import shows only while a source is running, with its waiting count", () => {
	expect(importJobs(extension({ reddit: idle }))).toEqual([]);
	expect(importJobs(extension({ reddit: { ...idle, phase: "running", queued: 118, uploading: 2 } }))[0]?.label).toBe("Importing 120 Reddit saves");
	expect(importJobs(extension({ x: { ...idle, phase: "running" }, tiktok: { ...idle, phase: "running" } }))[0]?.label).toBe("Importing from X and TikTok");
	expect(importJobs(extension({ reddit: { ...idle, phase: "running" } }, "disconnected"))).toEqual([]);
});

const ai = (patch: Partial<AiSettingsResponse> & { tagging?: number; indexing?: number; auto?: number }): AiSettingsResponse => ({
	settings: { semanticSearchEnabled: 1, semanticIndexPaused: 0, semanticBudgetLimit: 0, semanticBudgetUsed: 0, semanticBudgetMonth: "", semanticGeneration: 0, autoTaggingEnabled: patch.auto ?? 1, embeddingModel: "", embeddingDimensions: 0, tagModel: "", quotaPauseReason: null, lastRunAt: null },
	progress: { pending: 0, failed: 0, complete: 0 },
	embeddingProgress: { pending: 0, failed: 0, complete: 0 },
	taggingProgress: { pending: patch.tagging ?? 0, failed: 0, complete: 0 },
	semanticIndex: { indexed: 0, pending: patch.indexing ?? 0, total: 0 },
	available: true,
	taxonomyVersion: "v2",
	...patch,
});

test("tagging and indexing appear only with a backlog the server can work", () => {
	expect(aiJobs(ai({}))).toEqual([]);
	expect(aiJobs(ai({ tagging: 267 })).map((job) => job.label)).toEqual(["Tagging 267 saves"]);
	expect(aiJobs(ai({ tagging: 267, auto: 0 }))).toEqual([]);
	expect(aiJobs(ai({ indexing: 1 })).map((job) => job.label)).toEqual(["Indexing 1 save for search"]);
	expect(aiJobs(ai({ tagging: 5, available: false }))).toEqual([]);
});

test("the extension tooltip names the version only when connected", () => {
	expect(extensionTitle(extension({}), "x")).toBe("Extension connected · v1.0.25");
	expect(extensionTitle(extension({}, "disconnected"), "Extension offline")).toBe("Extension offline");
});

test("a topic keeps one colour, whatever the case or spacing", () => {
	expect(topicColorIndex("AI / ML")).toBe(topicColorIndex("  ai / ml "));
	for (const label of ["Design", "Web Dev", "Gaming", "Food & Travel"]) {
		const index = topicColorIndex(label);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(index).toBeLessThan(TOPIC_PALETTE_SIZE);
	}
});
