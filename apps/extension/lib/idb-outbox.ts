import type { OutboxRecord, OutboxStore } from "./capture-queue.ts";

const DATABASE_NAME = "anansi-extension";
const DATABASE_VERSION = 1;
const OUTBOX = "outbox";
const SYNC_STATE = "syncState";

export interface SyncStateRecord {
	source: string;
	cursor?: string;
	phase: string;
	updatedAt: number;
	runId?: string;
	startedAt?: number;
	nextPage?: number;
	pendingRefresh?: boolean;
	createdTabId?: number;
}

export interface IndexedDbOutbox extends OutboxStore {
	getSyncState(source: string): Promise<SyncStateRecord | null>;
	putSyncState(state: SyncStateRecord): Promise<void>;
	deleteSyncState(source: string): Promise<void>;
}

export interface IndexedDbOutboxOptions {
	factory?: IDBFactory;
	name?: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

/** IndexedDB adapter for the queue's persisted outbox seam. */
export function createIndexedDbOutbox(
	options: IndexedDbOutboxOptions = {},
): IndexedDbOutbox {
	const factory = options.factory ?? indexedDB;
	const name = options.name ?? DATABASE_NAME;
	let database: Promise<IDBDatabase> | null = null;

	const open = () => {
		if (database) return database;
		database = new Promise((resolve, reject) => {
			const request = factory.open(name, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(OUTBOX)) {
					const outbox = db.createObjectStore(OUTBOX, { keyPath: "eventId" });
					outbox.createIndex("state", "state", { unique: false });
					outbox.createIndex("source", "source", { unique: false });
					outbox.createIndex("nextAttemptAt", "nextAttemptAt", {
						unique: false,
					});
				}
				if (!db.objectStoreNames.contains(SYNC_STATE)) {
					db.createObjectStore(SYNC_STATE, { keyPath: "source" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error("IndexedDB open failed"));
			request.onblocked = () =>
				reject(new Error("IndexedDB upgrade was blocked"));
		});
		return database;
	};

	return {
		async add(record) {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readwrite");
			const done = transactionDone(transaction);
			const store = transaction.objectStore(OUTBOX);
			const existing = await requestResult(store.get(record.eventId));
			if (existing !== undefined) {
				await done;
				return false;
			}
			await requestResult(store.add(record));
			await done;
			return true;
		},

		async get(eventId) {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readonly");
			const done = transactionDone(transaction);
			const value = await requestResult<OutboxRecord | undefined>(
				transaction.objectStore(OUTBOX).get(eventId),
			);
			await done;
			return value ?? null;
		},

		async put(record) {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readwrite");
			const done = transactionDone(transaction);
			await requestResult(transaction.objectStore(OUTBOX).put(record));
			await done;
		},

		async delete(eventId) {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readwrite");
			const done = transactionDone(transaction);
			await requestResult(transaction.objectStore(OUTBOX).delete(eventId));
			await done;
		},

		async list() {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readonly");
			const done = transactionDone(transaction);
			const records = await requestResult<OutboxRecord[]>(
				transaction.objectStore(OUTBOX).getAll(),
			);
			await done;
			return records;
		},

		async recoverUploading(now) {
			const db = await open();
			const transaction = db.transaction(OUTBOX, "readwrite");
			const done = transactionDone(transaction);
			const store = transaction.objectStore(OUTBOX);
			const records = await requestResult<OutboxRecord[]>(store.getAll());
			const abandoned = records.filter(
				(record) => record.state === "uploading",
			);
			for (const record of abandoned) {
				store.put({
					...record,
					state: "queued",
					nextAttemptAt: now,
					updatedAt: now,
				});
			}
			await done;
			return abandoned.length;
		},

		async getSyncState(source) {
			const db = await open();
			const transaction = db.transaction(SYNC_STATE, "readonly");
			const done = transactionDone(transaction);
			const value = await requestResult<SyncStateRecord | undefined>(
				transaction.objectStore(SYNC_STATE).get(source),
			);
			await done;
			return value ?? null;
		},

		async putSyncState(state) {
			const db = await open();
			const transaction = db.transaction(SYNC_STATE, "readwrite");
			const done = transactionDone(transaction);
			await requestResult(transaction.objectStore(SYNC_STATE).put(state));
			await done;
		},

		async deleteSyncState(source) {
			const db = await open();
			const transaction = db.transaction(SYNC_STATE, "readwrite");
			const done = transactionDone(transaction);
			await requestResult(transaction.objectStore(SYNC_STATE).delete(source));
			await done;
		},
	};
}
