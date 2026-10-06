import { parseBookmarkCapture, type ItemEventCapture, type NormalizedItem } from "@anansi/sources";
import type { CaptureQueue } from "./capture-queue.ts";
import type { SyncStateRecord } from "./idb-outbox.ts";
import type { CaptureSource, SyncStateStore } from "./source-runs.ts";
import { completeNativeItem } from "./native-snapshot.ts";

export interface NativeMutation {
	source: CaptureSource;
	action: "save" | "unsave";
	externalId: string;
	canonicalUrl: string;
	mutationId: string;
	observedAt: number;
	normalizedItem?: NormalizedItem;
}

interface NativeState extends SyncStateRecord {
	epoch: string;
	sequence: number;
	recent: string[];
	mutations: Array<{ mutationId: string; capture: ItemEventCapture }>;
}

/** A durable handoff, including saves whose content has not arrived yet. */
export function createLiveCapture(deps: {
	store: SyncStateStore;
	queue: Pick<CaptureQueue, "enqueue">;
	now: () => number;
	createId: () => string;
	canEnqueue?: (source: CaptureSource) => Promise<boolean>;
}) {
	const tails = new Map<CaptureSource, Promise<unknown>>();
	const serial = <T>(source: CaptureSource, task: () => Promise<T>): Promise<T> => {
		const result = (tails.get(source) ?? Promise.resolve()).then(task, task);
		tails.set(source, result.catch(() => {}));
		return result;
	};
	const read = async (source: CaptureSource): Promise<NativeState> => {
		const value = await deps.store.getSyncState(`native:${source}`) as NativeState | null;
		return value ?? { source: `native:${source}`, phase: "idle", updatedAt: deps.now(),
			epoch: deps.createId(), sequence: 0, recent: [], mutations: [] };
	};
	const write = (state: NativeState) => deps.store.putSyncState({ ...state, updatedAt: deps.now() });
	const flush = async (source: CaptureSource, state: NativeState) => {
		if (state.mutations.length && deps.canEnqueue && !(await deps.canEnqueue(source))) {
			return { pending: state.mutations.length, needsContent: state.mutations.some(({ capture }) => capture.action === "save" && !capture.normalizedItem) };
		}
		const blocked = new Set<string>();
		for (const record of [...state.mutations]) {
			const capture = record.capture;
			if (blocked.has(capture.externalId)) continue;
			if (capture.action === "save" && !capture.normalizedItem) {
				blocked.add(capture.externalId);
				continue;
			}
			try {
				await deps.queue.enqueue(capture);
			} catch {
				// Queue exhaustion or storage failures keep the original event here.
				blocked.add(capture.externalId);
				continue;
			}
			state.mutations = state.mutations.filter((entry) => entry !== record);
			await write(state);
		}
		return { pending: state.mutations.length, needsContent: state.mutations.some(({ capture }) => capture.action === "save" && !capture.normalizedItem) };
	};
	return {
		pending(source: CaptureSource): Promise<ItemEventCapture[]> {
			return serial(source, async () => (await read(source)).mutations.map(({ capture }) => capture));
		},
		record(mutation: NativeMutation) {
			return serial(mutation.source, async () => {
				if (mutation.normalizedItem && !completeNativeItem(mutation.normalizedItem)) mutation = { ...mutation, normalizedItem: undefined };
				const state = await read(mutation.source);
				if (!state.recent.includes(mutation.mutationId)) {
					const sequence = state.sequence + 1;
					if (!Number.isSafeInteger(sequence)) throw new Error("capture sequence exhausted");
					const capture: ItemEventCapture = {
						schemaVersion: 1, payloadType: "item_event", captureMethod: "platform_event",
						eventId: `${mutation.source}:native:${state.epoch}:${sequence}`,
						source: mutation.source, action: mutation.action, externalId: mutation.externalId,
						canonicalUrl: mutation.canonicalUrl, observedAt: mutation.observedAt,
						...(mutation.action === "save" && mutation.normalizedItem ? { normalizedItem: {
							...mutation.normalizedItem, savedAt: mutation.observedAt, savedAtIsExact: true,
						} } : {}),
					};
					const checked = parseBookmarkCapture(capture);
					if (!checked.ok) throw new Error(checked.error.message);
					// An unhydrated save has never reached the transport. Supersede it
					// before recording an unsave; later import pages cannot revive it.
					if (mutation.action === "unsave") state.mutations = state.mutations.filter(({ capture: old }) =>
						old.externalId !== mutation.externalId || old.action !== "save" || !!old.normalizedItem);
					// Check after supersession: a full recovery buffer must still allow
					// a pending save to be cancelled. Reserve additional control slots.
					if (state.mutations.length >= (mutation.action === "unsave" ? 400 : 200)) {
						throw new Error("pending capture storage is full");
					}
					state.sequence = sequence;
					state.recent = [...state.recent, mutation.mutationId].slice(-2_000);
					state.mutations.push({ mutationId: mutation.mutationId, capture });
					if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 25_000_000) {
						throw new Error("pending capture storage is full");
					}
					await write(state);
				} else if (mutation.normalizedItem) {
					const pending = state.mutations.find((entry) => entry.mutationId === mutation.mutationId);
					if (pending?.capture.action === "save" && !pending.capture.normalizedItem) {
						const capture = { ...pending.capture, canonicalUrl: mutation.normalizedItem.url,
							normalizedItem: { ...mutation.normalizedItem, savedAt: pending.capture.observedAt, savedAtIsExact: true } };
						if (parseBookmarkCapture(capture).ok) { pending.capture = capture; await write(state); }
					}
				}
				return flush(mutation.source, state);
			});
		},
		hydrate(source: CaptureSource, items: NormalizedItem[]) {
			return serial(source, async () => {
				const state = await read(source);
				for (const record of state.mutations) {
					const capture = record.capture;
					if (capture.action !== "save" || capture.normalizedItem) continue;
					const item = items.find((item) => item.source === source && item.externalId === capture.externalId);
					if (!item || !completeNativeItem(item)) continue;
					const hydrated = { ...capture, canonicalUrl: item.url, normalizedItem: { ...item, savedAt: capture.observedAt, savedAtIsExact: true } };
					if (parseBookmarkCapture(hydrated).ok) record.capture = hydrated;
				}
				await write(state);
				return flush(source, state);
			});
		},
		retry(source: CaptureSource) {
			return serial(source, async () => flush(source, await read(source)));
		},
	};
}
