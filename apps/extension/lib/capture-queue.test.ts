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
	test("upgrade assigns deterministic order without losing legacy records", async () => {
		const h = setup();
		await h.queue.enqueue(capture("z-older"));
		await h.queue.enqueue(capture("a-newer"));
		for (const record of await h.store.list()) {
			const { sequence: _sequence, ...legacy } = record;
			await h.store.put({ ...legacy, createdAt: record.eventId === "z-older" ? 1 : 2 });
		}
		const restart = createCaptureQueue({ ...h, random: () => 0.5 });
		expect(await restart.getStatus()).toMatchObject({ queued: 2 });
		const upgraded = (await h.store.list()).sort((a, b) => a.sequence! - b.sequence!);
		expect(upgraded.map((record) => [record.eventId, record.sequence])).toEqual([["z-older", 1], ["a-newer", 2]]);
		expect(upgraded.map((record) => record.capture)).toEqual([capture("z-older"), capture("a-newer")]);
		expect(h.scheduler.times.at(-1)).toBe(h.clock.now());
	});
	test("restart finishes an interrupted same-millisecond ordering upgrade in the original order", async () => {
		const h = setup();
		for (const id of ["alpha", "beta", "gamma"]) await h.queue.enqueue(capture(id));
		for (const record of await h.store.list()) {
			const { sequence: _sequence, ...legacy } = record;
			await h.store.put({ ...legacy, createdAt: 100 });
		}
		const first = await h.store.get("alpha");
		await h.store.put({ ...first!, sequence: 1 });
		const restarted = createCaptureQueue({ ...h, random: () => 0.5 });
		await restarted.getStatus();
		const ordered = (await h.store.list()).sort((a, b) => a.sequence! - b.sequence!);
		expect(ordered.map((record) => record.eventId)).toEqual(["alpha", "beta", "gamma"]);
	});
	test("a later unsave retires a terminally failed save without retrying stale state", async () => {
		const first = capture("bad-save");
		const unsave = capture("later-unsave", "x", { action: "unsave", externalId: first.externalId,
			canonicalUrl: first.canonicalUrl, normalizedItem: undefined });
		const h = setup([{ kind: "http", status: 422 }, { kind: "success", receipt: {
			eventId: unsave.eventId, itemId: null, outcome: "ignored_stale",
		} }]);
		await h.queue.enqueue(first);
		await h.queue.retry();
		expect((await h.store.get(first.eventId))?.state).toBe("failed");
		await h.queue.enqueue(unsave);
		expect(await h.store.get(first.eventId)).toBeNull();
		await h.queue.retry({ includeFailed: true });
		expect(h.transport.calls.map((record) => record.eventId)).toEqual([first.eventId, unsave.eventId]);
		expect(await h.store.get(unsave.eventId)).toBeNull();
	});
	test("retires a failed save and delivers its already queued unsave in the same drain", async () => {
		const save = capture("queued-bad-save");
		const unsave = capture("queued-later-unsave", "x", { action: "unsave", externalId: save.externalId,
			canonicalUrl: save.canonicalUrl, normalizedItem: undefined });
		const h = setup([
			{ kind: "http", status: 422 },
			{ kind: "success", receipt: { eventId: unsave.eventId, itemId: null, outcome: "ignored_stale" } },
		]);

		await h.queue.enqueue(save);
		await h.queue.enqueue(unsave);
		await h.queue.retry();

		expect(h.transport.calls.map((record) => record.eventId)).toEqual([save.eventId, unsave.eventId]);
		expect(await h.store.list()).toHaveLength(0);
	});
	test("an unsave can supersede a failed save even when that failure filled the queue", async () => {
		const first = capture("full-bad-save");
		const unsave = capture("full-later-unsave", "x", { action: "unsave", externalId: first.externalId,
			canonicalUrl: first.canonicalUrl, normalizedItem: undefined });
		const h = setup([{ kind: "http", status: 422 }], { maxTotalBytes: 500 });
		await h.queue.enqueue(first);
		await h.queue.retry();
		const old = await h.store.get(first.eventId);
		expect(old?.state).toBe("failed");
		expect(old!.sizeBytes + new TextEncoder().encode(JSON.stringify(unsave)).byteLength).toBeGreaterThan(500);
		await h.queue.enqueue(unsave);
		expect(await h.store.get(first.eventId)).toBeNull();
		expect((await h.store.get(unsave.eventId))?.state).toBe("queued");
	});
	test("retrying save blocks its unsave but not unrelated live items", async () => {
		const success = (r: OutboxRecord) => ({ kind: "success" as const, receipt: { eventId: r.eventId, itemId: "i", outcome: "created" } });
		const h = setup([{ kind: "network" }, success, success, success]);
		const save = capture("first");
		await h.queue.enqueue(save);
		await h.queue.retry();
		await h.queue.enqueue(capture("second", "x", { action: "unsave", externalId: save.externalId, normalizedItem: undefined }));
		await h.queue.enqueue(capture("unrelated"));
		await h.queue.retry();
		expect(h.transport.calls.map((c) => c.eventId)).toEqual(["first", "unrelated"]);
		h.clock.set(20_000);
		await h.queue.retry();
		expect(h.transport.calls.map((c) => c.eventId)).toEqual(["first", "unrelated", "first", "second"]);
	});
	test("live saves overtake queued import pages between requests", async () => {
		const success = (r: OutboxRecord) => ({ kind: "success" as const, receipt: { eventId: r.eventId, itemId: "i", outcome: "created" } });
		const h = setup([success, success]);
		await h.queue.enqueue({ schemaVersion: 1, payloadType: "raw_page", eventId: "history", source: "x", action: "snapshot",
			observedAt, captureMethod: "platform_import", runId: "run", page: 1, raw: {} });
		await h.queue.enqueue(capture("live"));
		await h.queue.retry();
		expect(h.transport.calls.map((c) => c.eventId)).toEqual(["live", "history"]);
	});
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
	describe("import pages cannot wedge a source", () => {
		const success = (r: OutboxRecord) => ({ kind: "success" as const, receipt: { eventId: r.eventId, itemId: "i", outcome: "created" as const } });
		const page = (eventId: string, n: number, filler = ""): BookmarkCapture => ({
			schemaVersion: 1, payloadType: "raw_page", eventId, source: "x", action: "snapshot",
			observedAt, captureMethod: "platform_import", runId: "run", page: n, raw: { filler },
		});

		test("a permanently failed page does not block later pages from the same source", async () => {
			const h = setup([{ kind: "http", status: 422 }, success, success]);
			await h.queue.enqueue(page("bad", 1));
			await h.queue.enqueue(page("next", 2));
			await h.queue.enqueue(page("after", 3));
			const status = await h.queue.retry();
			expect(h.transport.calls.map((c) => c.eventId)).toEqual(["bad", "next", "after"]);
			expect(status).toEqual({ queued: 0, uploading: 0, retrying: 0, failed: 1 });
		});

		test("a permanently failed page does not block a content-less save behind it", async () => {
			const h = setup([{ kind: "http", status: 422 }, success]);
			const bare = capture("bare-save", "x", { normalizedItem: undefined });
			await h.queue.enqueue(page("bad", 1));
			await h.queue.enqueue(bare);
			await h.queue.retry();
			expect(h.transport.calls.map((c) => c.eventId)).toEqual(["bad", "bare-save"]);
		});

		test("a page that keeps returning server errors eventually fails and releases the source", async () => {
			const error = { kind: "http" as const, status: 500 };
			const h = setup([...Array.from({ length: 12 }, () => error), success], { baseRetryMs: 1, maxRetryMs: 1 });
			await h.queue.enqueue(page("poison", 1));
			await h.queue.enqueue(page("next", 2));
			for (let i = 0; i < 12; i++) {
				h.clock.set(h.clock.now() + 10);
				await h.queue.retry();
			}
			expect((await h.store.get("poison"))?.state).toBe("failed");
			expect(h.transport.calls.at(-1)?.eventId).toBe("next");
			expect(await h.store.get("next")).toBeNull();
		});

		test("gateway errors during an outage never fail a page", async () => {
			const h = setup(Array.from({ length: 20 }, () => ({ kind: "http" as const, status: 503 })), { baseRetryMs: 1, maxRetryMs: 1 });
			await h.queue.enqueue(page("outage", 1));
			for (let i = 0; i < 20; i++) {
				h.clock.set(h.clock.now() + 10);
				await h.queue.retry();
			}
			expect((await h.store.get("outage"))?.state).toBe("retry_wait");
		});

		test("a different failure between server errors restarts the count", async () => {
			const error = { kind: "http" as const, status: 500 };
			const h = setup([...Array.from({ length: 11 }, () => error), { kind: "network" as const }, error], { baseRetryMs: 1, maxRetryMs: 1 });
			await h.queue.enqueue(page("flaky", 1));
			for (let i = 0; i < 13; i++) {
				h.clock.set(h.clock.now() + 10);
				await h.queue.retry();
			}
			expect((await h.store.get("flaky"))?.state).toBe("retry_wait");
		});

		test("network errors never fail a page, because they say nothing about the page", async () => {
			const h = setup(Array.from({ length: 12 }, () => ({ kind: "network" as const })), { baseRetryMs: 1, maxRetryMs: 1 });
			await h.queue.enqueue(page("offline", 1));
			for (let i = 0; i < 12; i++) {
				h.clock.set(h.clock.now() + 10);
				await h.queue.retry();
			}
			expect((await h.store.get("offline"))?.state).toBe("retry_wait");
		});

		test("rate limiting never fails a page", async () => {
			const h = setup(Array.from({ length: 12 }, () => ({ kind: "http" as const, status: 429 })), { baseRetryMs: 1, maxRetryMs: 1 });
			await h.queue.enqueue(page("limited", 1));
			for (let i = 0; i < 12; i++) {
				h.clock.set(h.clock.now() + 10);
				await h.queue.retry();
			}
			expect((await h.store.get("limited"))?.state).toBe("retry_wait");
		});

		test("import pages stop before live saves run out of room", async () => {
			const h = setup([], { maxTotalBytes: 10_000, liveReserveBytes: 3_000 });
			await h.queue.enqueue(page("fills-import-budget", 1, "x".repeat(6_500)));
			await expect(h.queue.enqueue(page("over-budget", 2, "x".repeat(1_000)))).rejects.toMatchObject({ code: "queue_full" });
			await expect(h.queue.enqueue(capture("live-still-fits"))).resolves.toMatchObject({ state: "queued", duplicate: false });
		});

		test("reports when import pages can be admitted again", async () => {
			const h = setup([success, success], { maxTotalBytes: 10_000, liveReserveBytes: 3_000 });
			await h.queue.enqueue(page("large", 1, "x".repeat(6_500)));
			await h.queue.enqueue(capture("live"));
			expect(await h.queue.hasImportRoom()).toBe(false);
			await h.queue.retry();
			expect(await h.queue.hasImportRoom()).toBe(true);
		});

		test("an explicit retry also wakes captures waiting out a backoff", async () => {
			const h = setup([{ kind: "network" }, success], { baseRetryMs: 3_600_000, maxRetryMs: 3_600_000 });
			await h.queue.enqueue(capture("waiting"));
			await h.queue.retry();
			expect((await h.store.get("waiting"))?.state).toBe("retry_wait");
			await h.queue.retry();
			expect(h.transport.calls.length).toBe(1);
			await h.queue.retry({ includeFailed: true });
			expect(h.transport.calls.length).toBe(2);
			expect(await h.store.get("waiting")).toBeNull();
		});

		test("a recovered server resumes outage retries but keeps rate-limit waits", async () => {
			const h = setup(
				[{ kind: "network" }, { kind: "http", status: 503 }, { kind: "http", status: 429, retryAfterMs: 3_600_000 }, success, success],
				{ baseRetryMs: 3_600_000, maxRetryMs: 3_600_000 },
			);
			await h.queue.enqueue(capture("a", "x"));
			await h.queue.enqueue(capture("b", "reddit"));
			await h.queue.retry();
			await h.queue.enqueue(capture("c", "github"));
			await h.queue.retry();
			expect((await h.store.get("c"))?.state).toBe("retry_wait");
			await h.queue.retry({ resetBackoff: true });
			expect(await h.store.get("a")).toBeNull();
			expect(await h.store.get("b")).toBeNull();
			expect((await h.store.get("c"))?.state).toBe("retry_wait");
		});

		test("live saves are still limited by the total", async () => {
			const size = new TextEncoder().encode(JSON.stringify(capture("first"))).byteLength;
			const h = setup([], { maxTotalBytes: size * 2 + 50, liveReserveBytes: 50 });
			await h.queue.enqueue(capture("first"));
			await h.queue.enqueue(capture("secnd"));
			await expect(h.queue.enqueue(capture("third"))).rejects.toBeInstanceOf(QueueLimitError);
		});
	});
});
