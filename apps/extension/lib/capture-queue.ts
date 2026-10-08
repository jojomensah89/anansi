import {
	type BookmarkCapture,
	type CaptureQueueStatus,
	type CaptureReceipt,
	parseBookmarkCapture,
} from "@anansi/sources";
import type { CaptureTransport, TransportResult } from "./ingest-transport.ts";

export type OutboxState = "queued" | "uploading" | "retry_wait" | "failed";

export interface QueueError {
	code: "network" | "http" | "invalid_receipt";
	message: string;
	status?: number;
}

export interface OutboxRecord {
	/** Persisted admission order; absent only on pre-upgrade records. */
	sequence?: number;
	eventId: string;
	source: BookmarkCapture["source"];
	capture: BookmarkCapture;
	payloadHash: string;
	state: OutboxState;
	attempts: number;
	nextAttemptAt: number;
	createdAt: number;
	updatedAt: number;
	sizeBytes: number;
	lastError?: QueueError;
}

export interface OutboxStore {
	add(record: OutboxRecord): Promise<boolean>;
	get(eventId: string): Promise<OutboxRecord | null>;
	put(record: OutboxRecord): Promise<void>;
	delete(eventId: string): Promise<void>;
	list(): Promise<OutboxRecord[]>;
	recoverUploading(now: number): Promise<number>;
}

export interface QueueClock {
	now(): number;
}

export interface WakeScheduler {
	schedule(at: number): Promise<void> | void;
}

export interface CaptureQueueDependencies {
	store: OutboxStore;
	transport: CaptureTransport;
	clock: QueueClock;
	random: () => number;
	scheduler: WakeScheduler;
}

export interface CaptureQueueOptions {
	maxRecordBytes?: number;
	maxTotalBytes?: number;
	maxConcurrency?: number;
	baseRetryMs?: number;
	maxRetryMs?: number;
}

export interface EnqueueResult {
	eventId: string;
	payloadHash: string;
	state: OutboxState;
	duplicate: boolean;
}

export interface RetryRequest {
	eventId?: string;
	/** Explicit user action: make permanently failed records eligible again. */
	includeFailed?: boolean;
	/** Narrow that to one source, for a retry pressed on one row. */
	source?: BookmarkCapture["source"];
}

export interface CaptureQueue {
	enqueue(capture: BookmarkCapture): Promise<EnqueueResult>;
	getStatus(): Promise<CaptureQueueStatus>;
	/** Drain due work, with optional explicit requeueing of visible failures. */
	retry(request?: RetryRequest): Promise<CaptureQueueStatus>;
}

export class QueueLimitError extends Error {
	constructor(
		public readonly code: "record_too_large" | "queue_full",
		message: string,
	) {
		super(message);
		this.name = "QueueLimitError";
	}
}

export class EventCollisionError extends Error {
	constructor(eventId: string) {
		super(`capture event id was reused with different content: ${eventId}`);
		this.name = "EventCollisionError";
	}
}

export class InvalidCaptureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCaptureError";
	}
}

const DEFAULTS = {
	maxRecordBytes: 2_000_000,
	maxTotalBytes: 25_000_000,
	maxConcurrency: 2,
	baseRetryMs: 1_000,
	maxRetryMs: 60 * 60 * 1_000,
};

function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function payloadHash(capture: BookmarkCapture): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(capture));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function prepareCapture(
	capture: BookmarkCapture,
	maxRecordBytes: number,
): { capture: BookmarkCapture; sizeBytes: number } {
	const validated = parseBookmarkCapture(capture);
	if (!validated.ok) throw new InvalidCaptureError(validated.error.message);

	let prepared = validated.capture;
	let sizeBytes = serializedBytes(prepared);
	if (
		sizeBytes > maxRecordBytes &&
		prepared.payloadType === "item_event" &&
		prepared.normalizedItem
	) {
		prepared = {
			...prepared,
			normalizedItem: { ...prepared.normalizedItem, raw: {} },
		};
		sizeBytes = serializedBytes(prepared);
	}
	if (sizeBytes > maxRecordBytes) {
		throw new QueueLimitError(
			"record_too_large",
			"capture exceeds the durable queue record limit",
		);
	}
	return { capture: prepared, sizeBytes };
}

function isReceiptFor(
	value: unknown,
	eventId: string,
): value is CaptureReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const receipt = value as Partial<CaptureReceipt>;
	return (
		receipt.eventId === eventId &&
		(receipt.itemId === null || typeof receipt.itemId === "string") &&
		["created", "updated", "duplicate", "ignored_stale"].includes(
			String(receipt.outcome),
		)
	);
}

function isRetryable(result: TransportResult): boolean {
	return (
		result.kind === "network" ||
		(result.kind === "http" &&
			([408, 425, 429].includes(result.status) || result.status >= 500))
	);
}

function errorFor(result: TransportResult): QueueError {
	if (result.kind === "network") {
		return { code: "network", message: "network request failed" };
	}
	if (result.kind === "http") {
		return {
			code: "http",
			status: result.status,
			message: `ingest returned HTTP ${result.status}${result.detail ? `: ${result.detail}` : ""}`,
		};
	}
	return {
		code: "invalid_receipt",
		message: "ingest returned an invalid receipt",
	};
}

function countStatus(records: OutboxRecord[]): CaptureQueueStatus {
	return records.reduce<CaptureQueueStatus>(
		(counts, record) => {
			if (record.state === "queued") counts.queued++;
			else if (record.state === "uploading") counts.uploading++;
			else if (record.state === "retry_wait") counts.retrying++;
			else counts.failed++;
			return counts;
		},
		{ queued: 0, uploading: 0, retrying: 0, failed: 0 },
	);
}

/**
 * Durable capture queue. IndexedDB transactions, retry policy, concurrency,
 * receipt verification, and scheduling stay behind three caller operations.
 */
export function createCaptureQueue(
	dependencies: CaptureQueueDependencies,
	options: CaptureQueueOptions = {},
): CaptureQueue {
	const config = { ...DEFAULTS, ...options };
	const { store, transport, clock, random, scheduler } = dependencies;
	let recovery: Promise<void> | null = null;
	let drain: Promise<void> | null = null;
	let enqueueTail: Promise<void> = Promise.resolve();

	const schedule = async (at: number) => {
		try {
			await scheduler.schedule(at);
		} catch {
			// The record is already durable. A later startup/alarm recovers it.
		}
	};

	const order = (a: OutboxRecord, b: OutboxRecord) =>
		(a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId);
	const legacyUpgradeOrder = (a: OutboxRecord, b: OutboxRecord) =>
		a.createdAt - b.createdAt ||
		// An interrupted upgrade leaves a numbered prefix. Keep it before
		// untouched rows with the same millisecond timestamp on restart.
		Number(b.sequence !== undefined) - Number(a.sequence !== undefined) ||
		(a.sequence ?? 0) - (b.sequence ?? 0) || a.eventId.localeCompare(b.eventId);
	const retireSupersededFailures = async (records: OutboxRecord[]) => {
		const latest = new Map<string, number>();
		for (const record of records) if (record.capture.payloadType === "item_event") {
			const key = `${record.source}:${record.capture.externalId}`;
			latest.set(key, Math.max(latest.get(key) ?? 0, record.sequence ?? 0));
		}
		const toDelete: Promise<void>[] = [];
		for (const record of records) if (record.state === "failed" && record.capture.payloadType === "item_event" &&
			(latest.get(`${record.source}:${record.capture.externalId}`) ?? 0) > (record.sequence ?? 0)) {
			toDelete.push(store.delete(record.eventId));
		}
		if (toDelete.length) await Promise.all(toDelete);
	};
	const scheduleRemaining = async () => {
		const records = await store.list();
		const eligible = records.filter((r) => r.state === "queued" || r.state === "retry_wait");
		if (eligible.length) await schedule(Math.max(clock.now(), Math.min(...eligible.map((r) => r.nextAttemptAt))));
	};
	const ensureRecovered = () => {
		if (!recovery) recovery = (async () => {
			await store.recoverUploading(clock.now());
			const records = await store.list();
			if (records.some((r) => r.sequence === undefined)) {
				records.sort(legacyUpgradeOrder);
				await Promise.all(
					records.map((record, index) =>
						store.put({ ...record, sequence: index + 1 }),
					),
				);
			}
			await retireSupersededFailures(await store.list());
			await scheduleRemaining();
		})();
		return recovery;
	};

	const retryDelay = (
		record: OutboxRecord,
		response: TransportResult,
	): number => {
		if (response.kind === "http" && response.retryAfterMs !== undefined) {
			return Math.min(Math.max(0, response.retryAfterMs), config.maxRetryMs);
		}
		const exponent = Math.max(0, record.attempts - 1);
		const base = Math.min(
			config.baseRetryMs * 2 ** exponent,
			config.maxRetryMs,
		);
		const jitter = 0.5 + Math.min(1, Math.max(0, random()));
		return Math.min(Math.max(1, Math.round(base * jitter)), config.maxRetryMs);
	};

	const processRecord = async (candidate: OutboxRecord): Promise<void> => {
		const current = await store.get(candidate.eventId);
		if (!current) return;
		if (
			current.state !== "queued" &&
			!(current.state === "retry_wait" && current.nextAttemptAt <= clock.now())
		) {
			return;
		}

		const uploading: OutboxRecord = {
			...current,
			state: "uploading",
			attempts: current.attempts + 1,
			updatedAt: clock.now(),
			lastError: undefined,
		};
		await store.put(uploading);

		let response: TransportResult;
		try {
			response = await transport.send(uploading);
		} catch {
			response = { kind: "network" };
		}

		if (
			response.kind === "success" &&
			isReceiptFor(response.receipt, current.eventId)
		) {
			await store.delete(current.eventId);
			return;
		}
		const normalizedResponse: TransportResult =
			response.kind === "success" ? { kind: "invalid_receipt" } : response;
		if (isRetryable(normalizedResponse)) {
			const nextAttemptAt =
				clock.now() + retryDelay(uploading, normalizedResponse);
			await store.put({
				...uploading,
				state: "retry_wait",
				nextAttemptAt,
				updatedAt: clock.now(),
				lastError: errorFor(normalizedResponse),
			});
			await schedule(nextAttemptAt);
			return;
		}

		await store.put({
			...uploading,
			state: "failed",
			nextAttemptAt: 0,
			updatedAt: clock.now(),
			lastError: errorFor(normalizedResponse),
		});
	};

	const drainDue = async () => {
		await retireSupersededFailures(await store.list());
		const activeSources = new Set<string>();
		let picking: Promise<unknown> = Promise.resolve();
		const pick = (): Promise<OutboxRecord | undefined> => {
			const task = picking.then(async () => {
				// A preceding worker may have turned this item's save into a
				// terminal failure since the last pick. Retire it while selection
				// is serialized so a queued unsave can become the next item.
				await retireSupersededFailures(await store.list());
				const all = (await store.list()).sort(order);
				const firstItems = new Set<string>();
				const firstRaw = new Set<string>();
				const due: OutboxRecord[] = [];
				for (const record of all) {
					const capture = record.capture;
					if (capture.payloadType === "item_event") {
						const key = `${capture.source}:${capture.externalId}`;
						if (firstItems.has(key)) continue;
						firstItems.add(key);
						// Legacy id-only saves depend on their preceding raw page.
						if (capture.action === "save" && !capture.normalizedItem && firstRaw.has(capture.source)) continue;
					} else {
						if (firstRaw.has(record.source)) continue;
						firstRaw.add(record.source);
					}
					if (!activeSources.has(record.source) && (record.state === "queued" ||
						(record.state === "retry_wait" && record.nextAttemptAt <= clock.now()))) due.push(record);
				}
				due.sort((a, b) => Number(b.capture.payloadType === "item_event") - Number(a.capture.payloadType === "item_event") || order(a, b));
				const record = due[0];
				if (record) activeSources.add(record.source);
				return record;
			});
			picking = task.catch(() => {});
			return task;
		};
		const worker = async () => {
			while (true) {
				const record = await pick();
				if (!record) return;
				try { await processRecord(record); }
				finally { activeSources.delete(record.source); }
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, config.maxConcurrency) }, worker));
		// Only future retries require a new alarm. Blocked queued successors do
		// not spin the worker while their earlier item waits or needs attention.
		const remaining = await store.list();
		const future = remaining.filter((r) => r.state === "retry_wait").map((r) => r.nextAttemptAt);
		if (future.length) await schedule(Math.max(clock.now(), Math.min(...future)));
	};

	const retry = async (request?: RetryRequest): Promise<CaptureQueueStatus> => {
		await ensureRecovered();
		await retireSupersededFailures(await store.list());
		if (request?.includeFailed) {
			const failed = (await store.list()).filter(
				(record) =>
					record.state === "failed" &&
					(!request.source || record.source === request.source),
			);
			await Promise.all(
				failed.map((record) =>
					store.put({
						...record,
						state: "queued",
						nextAttemptAt: clock.now(),
						updatedAt: clock.now(),
						lastError: undefined,
					}),
				),
			);
		}
		if (request?.eventId) {
			const record = await store.get(request.eventId);
			if (
				record &&
				(record.state === "failed" || record.state === "retry_wait")
			) {
				await store.put({
					...record,
					state: "queued",
					nextAttemptAt: clock.now(),
					updatedAt: clock.now(),
					lastError: undefined,
				});
			}
		}
		if (!drain) drain = drainDue().finally(() => (drain = null));
		await drain;
		return countStatus(await store.list());
	};

	return {
		enqueue(capture) {
			const task = enqueueTail.then(async (): Promise<EnqueueResult> => {
				const prepared = prepareCapture(capture, config.maxRecordBytes);
				const [, hash] = await Promise.all([
					ensureRecovered(),
					payloadHash(prepared.capture),
				]);
				const [existing, records] = await Promise.all([
					store.get(prepared.capture.eventId),
					store.list(),
				]);
				if (existing) {
					if (existing.payloadHash !== hash) {
						throw new EventCollisionError(prepared.capture.eventId);
					}
					await retireSupersededFailures(records);
					return {
						eventId: existing.eventId,
						payloadHash: existing.payloadHash,
						state: existing.state,
						duplicate: true,
					};
				}
				const incomingItem = prepared.capture.payloadType === "item_event" ? prepared.capture : null;
				const totalBytes = records.reduce(
					(total, record) => total + (
						incomingItem && record.state === "failed" && record.capture.payloadType === "item_event" &&
						record.source === incomingItem.source && record.capture.externalId === incomingItem.externalId
							? 0 : record.sizeBytes),
					0,
				);
				if (totalBytes + prepared.sizeBytes > config.maxTotalBytes) {
					throw new QueueLimitError(
						"queue_full",
						"durable capture queue is full",
					);
				}
				const now = clock.now();
				const record: OutboxRecord = {
					sequence: Math.max(0, ...records.map((r) => r.sequence ?? 0)) + 1,
					eventId: prepared.capture.eventId,
					source: prepared.capture.source,
					capture: prepared.capture,
					payloadHash: hash,
					state: "queued",
					attempts: 0,
					nextAttemptAt: now,
					createdAt: now,
					updatedAt: now,
					sizeBytes: prepared.sizeBytes,
				};
				const added = await store.add(record);
				if (!added) throw new EventCollisionError(record.eventId);
				await retireSupersededFailures([...records, record]);
				await schedule(now);
				return {
					eventId: record.eventId,
					payloadHash: record.payloadHash,
					state: record.state,
					duplicate: false,
				};
			});
			enqueueTail = task.then(
				() => undefined,
				() => undefined,
			);
			return task;
		},
		async getStatus() {
			await ensureRecovered();
			return countStatus(await store.list());
		},
		retry,
	};
}
