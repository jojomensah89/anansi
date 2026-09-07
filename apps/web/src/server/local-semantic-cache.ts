import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AiProviderError, type VectorIndex, validateVector } from "./ai.ts";
import type {
	SemanticRuntimeSnapshot,
	SemanticRuntimeState,
} from "./semantic-search.ts";

type CacheState = SemanticRuntimeState | "paused";

interface VectorRow {
	itemId: string;
	contentHash: string;
	dimensions: number;
	values: Uint8Array | ArrayBuffer;
}

export interface LocalSemanticCache extends VectorIndex {
	readonly model: string;
	readonly generation: string;
	recordHash(id: string): string | null;
	hasRecord(id: string, contentHash: string): boolean;
	snapshot(): SemanticRuntimeSnapshot;
	setStatus(status: {
		state: CacheState;
		pending?: number;
		indexed?: number;
		dimension?: number;
		errorCode?: string;
	}): void;
	replaceGeneration(model: string): void;
	upsertRecords(
		records: Array<{ id: string; contentHash: string; values: number[] }>,
	): Promise<void>;
	invalidate(ids: string[]): Promise<void>;
	close(): void;
}

function blobToValues(blob: Uint8Array | ArrayBuffer): number[] {
	const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0)
		throw new AiProviderError("malformed", "sidecar vector bytes are invalid");
	const copy = bytes.slice();
	return [...new Float32Array(copy.buffer)];
}

function valuesToBlob(values: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer);
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Persistent local vector cache. It is intentionally a small brute-force
 * index: D1/SQLite remains authoritative for item data and this file stores
 * only model-scoped vector bytes plus operational status.
 */
export function openLocalSemanticCache(
	path: string,
	model: string,
): LocalSemanticCache {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS semantic_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_vectors (
      generation TEXT NOT NULL,
      item_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_blob BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (generation, item_id)
    );
    CREATE INDEX IF NOT EXISTS semantic_vectors_generation ON semantic_vectors(generation);
  `);

	// Keep explicit handles for every long-lived statement. Bun's SQLite
	// statements are finalized by the GC eventually, but a cache is commonly
	// closed immediately before its temporary directory is removed in tests or
	// during a dev-server restart. Explicit finalization avoids SQLITE_BUSY/
	// EBUSY in that lifecycle.
	const statements: Array<{ finalize(): void }> = [];
	const prepare = <T = unknown>(sql: string) => {
		const statement = db.query<T, SQLQueryBindings[]>(sql);
		statements.push(statement);
		return statement;
	};
	const getMetaStatement = prepare<{ value?: string }>(
		"SELECT value FROM semantic_meta WHERE key = ?",
	);
	const setMetaStatement = prepare(
		"INSERT INTO semantic_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
	);
	const countStatement = prepare<{ count?: number }>(
		"SELECT count(*) AS count FROM semantic_vectors WHERE generation = ?",
	);
	const deleteErrorStatement = prepare(
		"DELETE FROM semantic_meta WHERE key = ?",
	);
	const insertStatement = prepare(
		"INSERT INTO semantic_vectors(generation,item_id,content_hash,dimensions,vector_blob,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(generation,item_id) DO UPDATE SET content_hash=excluded.content_hash, dimensions=excluded.dimensions, vector_blob=excluded.vector_blob, updated_at=excluded.updated_at",
	);
	const removeStatement = prepare(
		"DELETE FROM semantic_vectors WHERE generation = ? AND item_id = ?",
	);
	const recordHashStatement = prepare<{ contentHash?: string }>(
		"SELECT content_hash AS contentHash FROM semantic_vectors WHERE generation = ? AND item_id = ?",
	);
	const selectStatement = prepare<VectorRow>(
		'SELECT item_id AS itemId, content_hash AS contentHash, dimensions, vector_blob AS "values" FROM semantic_vectors WHERE generation = ?',
	);

	const getMeta = (key: string): string | null => {
		const row = getMetaStatement.get(key) as { value?: string } | null;
		return row?.value ?? null;
	};
	const setMeta = (key: string, value: string): void => {
		setMetaStatement.run(key, value);
	};

	let activeModel = getMeta("model") ?? model;
	let generation = getMeta("generation") ?? crypto.randomUUID();
	if (!getMeta("model")) {
		setMeta("model", activeModel);
		setMeta("generation", generation);
		setMeta("state", "warming");
		setMeta("indexed", "0");
		setMeta("pending", "0");
	}

	const count = (): number => {
		const row = countStatement.get(generation) as { count?: number } | null;
		return Number(row?.count ?? 0);
	};

	const index: LocalSemanticCache = {
		get model() {
			return activeModel;
		},
		get generation() {
			return generation;
		},
		get dimensions() {
			return Number(getMeta("dimensions") ?? 0);
		},

		recordHash(id) {
			const row = recordHashStatement.get(generation, id) as {
				contentHash?: string;
			} | null;
			return row?.contentHash ?? null;
		},

		hasRecord(id, contentHash) {
			return index.recordHash(id) === contentHash;
		},

		snapshot() {
			const state = (getMeta("state") ??
				(count() > 0 ? "ready" : "warming")) as SemanticRuntimeState;
			return {
				state,
				model: activeModel,
				dimension: Number(getMeta("dimensions") ?? 0) || undefined,
				pending: Number(getMeta("pending") ?? 0),
				indexed: Number(getMeta("indexed") ?? count()),
			};
		},

		setStatus(status) {
			setMeta("state", status.state);
			if (status.pending !== undefined)
				setMeta("pending", String(Math.max(0, Math.floor(status.pending))));
			if (status.indexed !== undefined)
				setMeta("indexed", String(Math.max(0, Math.floor(status.indexed))));
			if (status.dimension !== undefined && status.dimension > 0)
				setMeta("dimensions", String(status.dimension));
			if (status.errorCode) setMeta("error", status.errorCode.slice(0, 80));
			else deleteErrorStatement.run("error");
		},

		replaceGeneration(nextModel) {
			if (nextModel === activeModel) return;
			activeModel = nextModel;
			generation = crypto.randomUUID();
			setMeta("model", activeModel);
			setMeta("generation", generation);
			setMeta("dimensions", "0");
			setMeta("state", "warming");
			setMeta("indexed", "0");
			setMeta("pending", "0");
		},

		async upsertRecords(records) {
			if (records.length === 0) return;
			// The cache is a single-process sidecar. Individual writes keep the
			// lifecycle simple (and avoid retaining Bun transaction handles across
			// an immediate close) while preserving idempotent upserts.
			for (const record of records) {
				const expected = index.dimensions || record.values.length;
				const values = validateVector(
					record.values,
					expected,
					"sidecar vector",
				);
				if (!index.dimensions) setMeta("dimensions", String(values.length));
				insertStatement.run(
					generation,
					record.id,
					record.contentHash,
					values.length,
					valuesToBlob(values),
					now(),
				);
			}
			setMeta("indexed", String(count()));
		},

		async upsert(vectors) {
			await index.upsertRecords(
				vectors.map((vector) => ({
					id: vector.id,
					contentHash: "",
					values: vector.values,
				})),
			);
		},

		async invalidate(ids) {
			if (ids.length === 0) return;
			for (const id of ids) removeStatement.run(generation, id);
			setMeta("indexed", String(count()));
		},

		async deleteByIds(ids) {
			await index.invalidate(ids);
		},

		async query(values, options = {}) {
			const dimensions = index.dimensions;
			if (dimensions > 0) validateVector(values, dimensions, "query vector");
			if (dimensions === 0) return [];
			const queryValues = values;
			const queryNorm = Math.sqrt(
				queryValues.reduce((sum, value) => sum + value * value, 0),
			);
			if (!Number.isFinite(queryNorm) || queryNorm === 0) return [];
			const topK = Math.min(
				Math.max(Math.floor(options.topK ?? 10), 0),
				count(),
			);
			if (topK === 0) return [];
			const rows = selectStatement.all(generation) as VectorRow[];
			return rows
				.map((row) => {
					const vector = blobToValues(row.values);
					if (row.dimensions !== dimensions || vector.length !== dimensions)
						throw new AiProviderError(
							"dimension",
							"sidecar vector dimension mismatch",
						);
					const norm = Math.sqrt(
						vector.reduce((sum, value) => sum + value * value, 0),
					);
					const score =
						norm === 0
							? 0
							: vector.reduce(
									(sum, value, i) => sum + value * (queryValues[i] ?? 0),
									0,
								) /
								(norm * queryNorm);
					return { id: row.itemId, score };
				})
				.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
				.slice(0, topK);
		},

		close() {
			for (const statement of statements) statement.finalize();
			db.close(true);
		},
	};

	return index;
}
