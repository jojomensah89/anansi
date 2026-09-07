import { describe, expect, test } from "bun:test";
import type { ItemEventCapture } from "@anansi/sources";
import { IDBFactory } from "fake-indexeddb";
import type { OutboxRecord } from "./capture-queue.ts";
import { createIndexedDbOutbox } from "./idb-outbox.ts";
import { createSourceRuns } from "./source-runs.ts";

const record = (
	eventId: string,
	state: OutboxRecord["state"] = "queued",
): OutboxRecord => {
	const capture: ItemEventCapture = {
		schemaVersion: 1,
		payloadType: "item_event",
		eventId,
		source: "web",
		action: "save",
		externalId: `web-${eventId}`,
		canonicalUrl: `https://example.com/${eventId}`,
		observedAt: 1_788_390_000,
		captureMethod: "toolbar",
		normalizedItem: {
			source: "web",
			externalId: `web-${eventId}`,
			url: `https://example.com/${eventId}`,
			kind: "article",
			body: eventId,
			savedAt: 1_788_390_000,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		},
	};
	return {
		eventId,
		source: "web",
		capture,
		payloadHash: `hash-${eventId}`,
		state,
		attempts: 0,
		nextAttemptAt: 1_000,
		createdAt: 1_000,
		updatedAt: 1_000,
		sizeBytes: 500,
	};
};

describe("IndexedDB outbox adapter", () => {
	test("persists records across adapter instances", async () => {
		const factory = new IDBFactory();
		const first = createIndexedDbOutbox({ factory, name: "anansi-persist" });
		await first.add(record("persisted"));

		const reopened = createIndexedDbOutbox({ factory, name: "anansi-persist" });
		expect(await reopened.get("persisted")).toEqual(record("persisted"));
	});

	test("creates outbox indexes and the syncState store", async () => {
		const factory = new IDBFactory();
		const outbox = createIndexedDbOutbox({ factory, name: "anansi-schema" });
		await outbox.list();
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open("anansi-schema", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const transaction = db.transaction("outbox", "readonly");
		const indexes = Array.from(transaction.objectStore("outbox").indexNames);

		expect(Array.from(db.objectStoreNames)).toEqual(["outbox", "syncState"]);
		expect(indexes).toEqual(["nextAttemptAt", "source", "state"]);
		db.close();
	});

	test("recovers uploading records and persists source sync state", async () => {
		const factory = new IDBFactory();
		const outbox = createIndexedDbOutbox({ factory, name: "anansi-recovery" });
		await outbox.add(record("abandoned", "uploading"));
		await outbox.recoverUploading(5_000);
		await outbox.putSyncState({
			source: "reddit",
			cursor: "after-1",
			phase: "idle",
			updatedAt: 5_000,
		});

		expect(await outbox.get("abandoned")).toMatchObject({
			state: "queued",
			nextAttemptAt: 5_000,
			updatedAt: 5_000,
		});
		expect(await outbox.getSyncState("reddit")).toEqual({
			source: "reddit",
			cursor: "after-1",
			phase: "idle",
			updatedAt: 5_000,
		});
	});

	test("coordinates SourceRuns across two adapters for one IndexedDB database", async () => {
		const factory = new IDBFactory();
		const firstStore = createIndexedDbOutbox({
			factory,
			name: "anansi-shared-coordination",
		});
		const secondStore = createIndexedDbOutbox({
			factory,
			name: "anansi-shared-coordination",
		});
		expect(firstStore.coordinationKey).toBe(secondStore.coordinationKey);

		const first = createSourceRuns({
			store: firstStore,
			now: () => 10_000,
			createId: () => "first",
		});
		const second = createSourceRuns({
			store: secondStore,
			now: () => 10_000,
			createId: () => "second",
		});

		expect(
			await Promise.all([
				first.nextItemEventSequence("github"),
				second.nextItemEventSequence("github"),
			]),
		).toEqual([1, 2]);
	});
});
