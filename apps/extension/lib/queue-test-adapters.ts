import type {
	OutboxRecord,
	OutboxStore,
	QueueClock,
	WakeScheduler,
} from "./capture-queue.ts";
import type { CaptureTransport, TransportResult } from "./ingest-transport.ts";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryOutboxStore implements OutboxStore {
	private readonly records = new Map<string, OutboxRecord>();

	async add(record: OutboxRecord): Promise<boolean> {
		if (this.records.has(record.eventId)) return false;
		this.records.set(record.eventId, clone(record));
		return true;
	}

	async get(eventId: string): Promise<OutboxRecord | null> {
		const record = this.records.get(eventId);
		return record ? clone(record) : null;
	}

	async put(record: OutboxRecord): Promise<void> {
		this.records.set(record.eventId, clone(record));
	}

	async delete(eventId: string): Promise<void> {
		this.records.delete(eventId);
	}

	async list(): Promise<OutboxRecord[]> {
		return [...this.records.values()].map(clone);
	}

	async recoverUploading(now: number): Promise<number> {
		let recovered = 0;
		for (const [eventId, record] of this.records) {
			if (record.state !== "uploading") continue;
			this.records.set(eventId, {
				...record,
				state: "queued",
				nextAttemptAt: now,
				updatedAt: now,
			});
			recovered++;
		}
		return recovered;
	}
}

export type ScriptedStep =
	| TransportResult
	| Error
	| ((record: OutboxRecord) => TransportResult | Promise<TransportResult>);

export class ScriptedTransport implements CaptureTransport {
	readonly calls: OutboxRecord[] = [];
	private next = 0;

	constructor(private readonly steps: ScriptedStep[]) {}

	async send(record: OutboxRecord): Promise<TransportResult> {
		this.calls.push(clone(record));
		const step = this.steps[this.next++];
		if (!step) throw new Error("no scripted transport response");
		if (step instanceof Error) throw step;
		return typeof step === "function" ? await step(record) : step;
	}
}

export class ManualClock implements QueueClock {
	constructor(private value: number) {}

	now(): number {
		return this.value;
	}

	set(value: number): void {
		this.value = value;
	}
}

export class RecordingWakeScheduler implements WakeScheduler {
	readonly times: number[] = [];

	schedule(at: number): void {
		this.times.push(at);
	}
}
