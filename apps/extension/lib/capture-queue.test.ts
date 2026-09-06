import { describe, expect, test } from "bun:test";
import type { BookmarkCapture, ItemEventCapture } from "@anansi/sources";
import {
	createCaptureQueue,
	EventCollisionError,
	type OutboxRecord,
	QueueLimitError,
} from "./capture-queue.ts";
import {
	ManualClock,
	MemoryOutboxStore,
	RecordingWakeScheduler,
	ScriptedTransport,
} from "./queue-test-adapters.ts";

const observedAt = 1_788_390_000;

const capture = (
	eventId: string,
	source: "x" | "reddit" | "github" | "web" = "x",
	overrides: Partial<ItemEventCapture> = {},
): ItemEventCapture => ({
	schemaVersion: 1,
	payloadType: "item_event",
	eventId,
	source,
	action: "save",
	externalId: `${source}-${eventId}`,
	canonicalUrl:
		source === "web"
			? `https://example.com/${eventId}`
			: `https://${source}.example/${eventId}`,
	observedAt,
	captureMethod: source === "web" ? "toolbar" : "platform_event",
	normalizedItem: {
		source,
		externalId: `${source}-${eventId}`,
		url:
			source === "web"
				? `https://example.com/${eventId}`
				: `https://${source}.example/${eventId}`,
		kind: source === "web" ? "article" : "post",
		body: `bookmark ${eventId}`,
		savedAt: observedAt,
		savedAtIsExact: true,
		metrics: {},
		media: [],
		links: [],
		raw: {},
	},
	...overrides,
});

const setup = (
	steps: ConstructorParameters<typeof ScriptedTransport>[0] = [],
	options: Parameters<typeof createCaptureQueue>[1] = {},
) => {
	const store = new MemoryOutboxStore();
	const transport = new ScriptedTransport(steps);
	const clock = new ManualClock(10_000);
	const scheduler = new RecordingWakeScheduler();
	const queue = createCaptureQueue(
		{ store, transport, clock, random: () => 0.5, scheduler },
		options,
	);
	return { store, transport, clock, scheduler, queue };
};

describe("CaptureQueue", () => {
	test("persists before transport and deletes only after a matching receipt", async () => {
		const event = capture("persist-first");
		const { queue, store, transport, scheduler } = setup([
			{
				kind: "success",
				receipt: {
					eventId: event.eventId,
					itemId: "item-1",
					outcome: "created",
				},
			},
		]);

		const enqueued = await queue.enqueue(event);
		expect((await store.list()).map((record) => record.eventId)).toEqual([
			event.eventId,
		]);
		expect(transport.calls).toHaveLength(0);
		expect(scheduler.times).toEqual([10_000]);
		expect(enqueued.state).toBe("queued");

		await queue.retry();
		expect(transport.calls).toHaveLength(1);
		expect(await store.list()).toHaveLength(0);
	});

	test("survives queue recreation and recovers abandoned uploading records", async () => {
		const first = setup();
		await first.queue.enqueue(capture("survives-restart"));
		const [persisted] = await first.store.list();
		expect(persisted).toBeDefined();
		if (!persisted) throw new Error("expected persisted record");
		await first.store.put({
			...persisted,
			state: "uploading",
			updatedAt: 9_000,
		});

		const second = createCaptureQueue({
			store: first.store,
			transport: new ScriptedTransport([]),
			clock: first.clock,
			random: () => 0.5,
			scheduler: first.scheduler,
		});
		const status = await second.getStatus();
		const [recovered] = await first.store.list();

		expect(status).toEqual({ queued: 1, uploading: 0, retrying: 0, failed: 0 });
		expect(recovered?.state).toBe("queued");
	});

	for (const response of [
		new Error("offline"),
		{ kind: "http" as const, status: 408 },
		{ kind: "http" as const, status: 425 },
		{ kind: "http" as const, status: 429 },
		{ kind: "http" as const, status: 503 },
	]) {
		test(`schedules a bounded retry for ${response instanceof Error ? "network errors" : response.status}`, async () => {
			const { queue, store, clock, scheduler } = setup([response]);
			await queue.enqueue(
				capture(
					`retry-${response instanceof Error ? "network" : response.status}`,
				),
			);
			await queue.retry();
			const [record] = await store.list();

			expect(record?.state).toBe("retry_wait");
			expect(record?.nextAttemptAt).toBeGreaterThan(clock.now());
			expect(record?.nextAttemptAt).toBeLessThanOrEqual(
				clock.now() + 60 * 60 * 1000,
			);
			expect(scheduler.times.at(-1)).toBe(record?.nextAttemptAt);
		});
	}

	test("Retry-After takes precedence over exponential backoff", async () => {
		const { queue, store, clock } = setup([
			{ kind: "http", status: 429, retryAfterMs: 120_000 },
		]);
		await queue.enqueue(capture("retry-after"));
		await queue.retry();

		const [record] = await store.list();
		expect(record?.nextAttemptAt).toBe(clock.now() + 120_000);
	});

	for (const status of [400, 401, 403, 413, 422]) {
		test(`keeps HTTP ${status} visible without retry spin`, async () => {
			const { queue, store, scheduler } = setup([{ kind: "http", status }]);
			await queue.enqueue(capture(`failed-${status}`));
			await queue.retry();
			const [record] = await store.list();

			expect(record?.state).toBe("failed");
			expect(record?.lastError?.status).toBe(status);
			expect(scheduler.times).toHaveLength(1);
		});
	}

	test("persists a safe server explanation with a permanent failure", async () => {
		const { queue, store } = setup([
			{ kind: "http", status: 422, detail: "invalid X bookmark payload" },
		]);
		await queue.enqueue(capture("failed-detail"));
		await queue.retry();

		expect((await store.list())[0]?.lastError?.message).toBe(
			"ingest returned HTTP 422: invalid X bookmark payload",
		);
	});

	test("retries permanent failures only after an explicit user request", async () => {
		const event = capture("manual-retry");
		const { queue, store, transport } = setup([
			{ kind: "http", status: 422 },
			{
				kind: "success",
				receipt: {
					eventId: event.eventId,
					itemId: "item-manual-retry",
					outcome: "created",
				},
			},
		]);
		await queue.enqueue(event);
		await queue.retry();

		expect((await store.get(event.eventId))?.state).toBe("failed");
		await queue.retry();
		expect(transport.calls).toHaveLength(1);

		await queue.retry({ includeFailed: true });
		expect(transport.calls).toHaveLength(2);
		expect(await store.get(event.eventId)).toBeNull();
	});

	test("retries preserve the event id, capture, and payload hash", async () => {
		const event = capture("stable-retry");
		const { queue, store, transport, clock } = setup([
			new Error("offline"),
			{
				kind: "success",
				receipt: {
					eventId: event.eventId,
					itemId: "item-2",
					outcome: "updated",
				},
			},
		]);
		const enqueued = await queue.enqueue(event);
		await queue.retry();
		const [waiting] = await store.list();
		expect(waiting?.payloadHash).toBe(enqueued.payloadHash);

		clock.set(waiting?.nextAttemptAt ?? clock.now());
		await queue.retry();
		expect(transport.calls).toHaveLength(2);
		expect(transport.calls.map((record) => record.eventId)).toEqual([
			event.eventId,
			event.eventId,
		]);
		expect(transport.calls[0]?.payloadHash).toBe(
			transport.calls[1]?.payloadHash,
		);
		expect(transport.calls[1]?.capture).toEqual(event);
	});

	test("is serial per source and bounded globally", async () => {
		const store = new MemoryOutboxStore();
		const clock = new ManualClock(10_000);
		const scheduler = new RecordingWakeScheduler();
		let active = 0;
		let maxActive = 0;
		const activeSources = new Set<string>();
		let sameSourceOverlap = false;
		const transport = {
			async send(record: OutboxRecord) {
				if (activeSources.has(record.source)) sameSourceOverlap = true;
				activeSources.add(record.source);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				activeSources.delete(record.source);
				return {
					kind: "success" as const,
					receipt: {
						eventId: record.eventId,
						itemId: record.eventId,
						outcome: "created" as const,
					},
				};
			},
		};
		const queue = createCaptureQueue(
			{ store, transport, clock, random: () => 0.5, scheduler },
			{ maxConcurrency: 2 },
		);
		await Promise.all([
			queue.enqueue(capture("x-1", "x")),
			queue.enqueue(capture("x-2", "x")),
			queue.enqueue(capture("reddit-1", "reddit")),
			queue.enqueue(capture("github-1", "github")),
		]);

		await queue.retry();
		expect(sameSourceOverlap).toBe(false);
		expect(maxActive).toBe(2);
		expect(await store.list()).toHaveLength(0);
	});

	test("strips optional normalized raw diagnostics before rejecting required content", async () => {
		const { queue, store } = setup([], { maxRecordBytes: 900 });
		const inner = capture("inner").normalizedItem;
		if (!inner) throw new Error("expected normalized test item");
		const withLargeRaw = capture("strip-raw", "x", {
			normalizedItem: {
				...inner,
				externalId: "x-strip-raw",
				url: "https://x.example/strip-raw",
				raw: { diagnostic: "x".repeat(2_000) },
			},
			externalId: "x-strip-raw",
			canonicalUrl: "https://x.example/strip-raw",
		});
		await queue.enqueue(withLargeRaw);
		const [stored] = await store.list();
		if (!stored) throw new Error("expected queued test item");
		expect((stored.capture as ItemEventCapture).normalizedItem?.raw).toEqual(
			{},
		);

		const requiredInner = capture("required-inner").normalizedItem;
		if (!requiredInner) throw new Error("expected normalized test item");
		const requiredContent = capture("required-too-large", "x", {
			normalizedItem: {
				...requiredInner,
				externalId: "x-required-too-large",
				url: "https://x.example/required-too-large",
				body: "y".repeat(2_000),
			},
			externalId: "x-required-too-large",
			canonicalUrl: "https://x.example/required-too-large",
		});
		await expect(queue.enqueue(requiredContent)).rejects.toBeInstanceOf(
			QueueLimitError,
		);
	});

	test("derives status from persisted records", async () => {
		const { queue, store } = setup();
		await Promise.all([
			queue.enqueue(capture("status-queued")),
			queue.enqueue(capture("status-retry", "reddit")),
			queue.enqueue(capture("status-failed", "github")),
		]);
		const records = await store.list();
		await Promise.all(
			records.map((record) =>
				store.put({
					...record,
					state: record.eventId.includes("retry")
						? "retry_wait"
						: record.eventId.includes("failed")
							? "failed"
							: "queued",
				}),
			),
		);

		expect(await queue.getStatus()).toEqual({
			queued: 1,
			uploading: 0,
			retrying: 1,
			failed: 1,
		});
	});

	test("deduplicates identical event ids and rejects hash collisions", async () => {
		const { queue, store } = setup();
		const first = capture("same-event");
		const original = await queue.enqueue(first);
		const duplicate = await queue.enqueue(first);
		expect(duplicate).toEqual({ ...original, duplicate: true });
		expect(await store.list()).toHaveLength(1);

		const changed: BookmarkCapture = {
			...first,
			canonicalUrl: "https://x.example/changed",
		};
		await expect(queue.enqueue(changed)).rejects.toBeInstanceOf(
			EventCollisionError,
		);
	});
});
