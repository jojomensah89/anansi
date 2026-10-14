import { describe, expect, test } from "bun:test";
import type { ItemEventCapture, NormalizedItem } from "@anansi/sources";
import type { SyncStateRecord } from "./idb-outbox.ts";
import { createLiveCapture, type NativeMutation } from "./live-capture.ts";

const item: NormalizedItem = { source: "x", externalId: "123", url: "https://x.com/author/status/123",
	kind: "post", body: "The complete post", savedAt: 100, savedAtIsExact: false,
	metrics: {}, media: [], links: [], raw: {} };
const mutation = (id: string, action: "save" | "unsave" = "save", content = true): NativeMutation => ({
	source: "x", action, externalId: "123", canonicalUrl: item.url, mutationId: id, observedAt: 100,
	...(content && action === "save" ? { normalizedItem: item } : {}),
});
function setup() {
	const states = new Map<string, SyncStateRecord>();
	const captures: ItemEventCapture[] = [];
	let fail = false;
	let enabled = true;
	const deps = { store: {
		async getSyncState(key: string) { return structuredClone(states.get(key) ?? null); },
		async putSyncState(value: SyncStateRecord) { states.set(value.source, structuredClone(value)); },
		async deleteSyncState(key: string) { states.delete(key); },
	}, queue: { async enqueue(capture: any) {
		if (fail) throw new Error("queue full");
		captures.push(structuredClone(capture));
		return { eventId: capture.eventId, payloadHash: "hash", state: "queued" as const, duplicate: false };
	} }, now: () => 100_000, createId: () => "installation",
		canEnqueue: async () => enabled };
	return { service: createLiveCapture(deps), restart: () => createLiveCapture(deps), captures,
		setFailure: (value: boolean) => { fail = value; },
		setEnabled: (value: boolean) => { enabled = value; } };
}

describe("native capture handoff", () => {
	test("holds a native event durably until this source is enabled for V2 delivery", async () => {
		const h = setup();
		h.setEnabled(false);
		expect(await h.service.record(mutation("gated"))).toEqual({ pending: 1, needsContent: false });
		expect(h.captures).toEqual([]);
		h.setEnabled(true);
		await h.restart().retry("x");
		expect(h.captures.map((event) => event.eventId)).toEqual(["x:native:installation:1"]);
	});
	test("diagnostics retain pending content across restart without delivering a placeholder", async () => {
		const h = setup();
		await h.service.record(mutation("waiting", "save", false));
		const pending = await h.restart().pending("x");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.normalizedItem).toBeUndefined();
		expect(pending[0]?.eventId).toBe("x:native:installation:1");
		expect(h.captures).toEqual([]);
	});
	test("persists a content-ready save and deduplicates the observer acknowledgement retry", async () => {
		const h = setup();
		expect(await h.service.record(mutation("request-1"))).toEqual({ pending: 0, needsContent: false });
		await h.restart().record(mutation("request-1"));
		expect(h.captures).toHaveLength(1);
		expect(h.captures[0]?.normalizedItem?.savedAtIsExact).toBe(true);
	});
	test("same-second save unsave save produces three distinct ordered events", async () => {
		const h = setup();
		await Promise.all([h.service.record(mutation("a")), h.service.record(mutation("b", "unsave")), h.service.record(mutation("c"))]);
		expect(h.captures.map((c) => c.action)).toEqual(["save", "unsave", "save"]);
		expect(new Set(h.captures.map((c) => c.eventId)).size).toBe(3);
	});
	test("recovery hydrates a pending save with original identity and action time", async () => {
		const h = setup();
		expect(await h.service.record(mutation("a", "save", false))).toEqual({ pending: 1, needsContent: true });
		expect(h.captures).toHaveLength(0);
		await h.restart().hydrate("x", [{ ...item, savedAt: 999 }]);
		expect(h.captures[0]?.eventId).toBe("x:native:installation:1");
		expect(h.captures[0]?.observedAt).toBe(100);
		expect(h.captures[0]?.normalizedItem?.savedAt).toBe(100);
	});
	test("an unsave cancels pending hydration and an old page cannot revive it", async () => {
		const h = setup();
		await h.service.record(mutation("a", "save", false));
		await h.service.record(mutation("b", "unsave"));
		await h.restart().hydrate("x", [item]);
		await h.restart().record(mutation("a")); // Late single-item lookup for the cancelled request.
		expect(h.captures.map((c) => c.action)).toEqual(["unsave"]);
	});
	test("queue exhaustion retains content and ordering across restart", async () => {
		const h = setup();
		h.setFailure(true);
		await h.service.record(mutation("a"));
		await h.service.record(mutation("b", "unsave"));
		h.setFailure(false);
		await h.restart().retry("x");
		expect(h.captures.map((c) => c.action)).toEqual(["save", "unsave"]);
	});
	test("one item missing content does not block another item", async () => {
		const h = setup();
		await h.service.record(mutation("a", "save", false));
		await h.service.record({ ...mutation("b"), externalId: "456", canonicalUrl: "https://x.com/author/status/456",
			normalizedItem: { ...item, externalId: "456", url: "https://x.com/author/status/456" } });
		expect(h.captures.map((c) => c.externalId)).toEqual(["456"]);
	});
	test("a full hydration buffer still accepts the unsave cancelling an entry", async () => {
		const h = setup();
		for (let i = 0; i < 200; i++) await h.service.record({ ...mutation(`save-${i}`, "save", false),
			externalId: String(i + 1), canonicalUrl: `https://x.com/author/status/${i + 1}` });
		await h.service.record({ ...mutation("cancel", "unsave"), externalId: "1", canonicalUrl: "https://x.com/author/status/1" });
		await h.service.hydrate("x", [{ ...item, externalId: "1", url: "https://x.com/author/status/1" }]);
		expect(h.captures.map((c) => c.action)).toEqual(["unsave"]);
	});
});
