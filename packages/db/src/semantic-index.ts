import { and, eq, inArray, sql } from "drizzle-orm";
import {
	aiEnrichmentJobs,
	aiSettings,
	itemEmbeddings,
	items,
	semanticChunks,
	semanticVectorDeletions,
} from "./schema.ts";
import { contentHash, semanticText } from "./ai-jobs.ts";
import { chunkSemanticText, SEMANTIC_CHUNKER_VERSION } from "./semantic-chunks.ts";
import type { AnansiDb } from "./types.ts";

export type SemanticChunkRow = typeof semanticChunks.$inferSelect;
export type SemanticChunkVector = { id: string; contentHash: string; values: number[] };

function boundedGroups<T>(values: readonly T[], size = 7): T[][] {
	const groups: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) groups.push(values.slice(offset, offset + size));
	return groups;
}

/** Prepare D1's authoritative chunk manifests before any vector is published. */
async function planSemanticChunks(item: typeof items.$inferSelect, model: string, generation = 1) {
	const projection = semanticText(item);
	const parentHash = await contentHash(projection);
	const texts = chunkSemanticText(projection);
	const occurrences = new Map<string, number>();
	const now = Math.floor(Date.now() / 1000);
	const drafts: (typeof semanticChunks.$inferInsert)[] = [];
	for (const chunk of texts) {
		const chunkHash = await contentHash(chunk.text);
		const occurrence = occurrences.get(chunkHash) ?? 0;
		occurrences.set(chunkHash, occurrence + 1);
		const id = await contentHash(`${item.id}\u0000${generation}\u0000${model}\u0000${SEMANTIC_CHUNKER_VERSION}\u0000${chunkHash}\u0000${occurrence}`);
		drafts.push({
			id,
			itemId: item.id,
			chunkIndex: chunk.index,
			chunkText: chunk.text,
			contentHash: chunkHash,
			parentHash,
			startOffset: chunk.startOffset,
			endOffset: chunk.endOffset,
			chunkerVersion: SEMANTIC_CHUNKER_VERSION,
			model,
			generation,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		});
	}
	return { parentHash, drafts };
}

export async function stageSemanticChunks(db: AnansiDb, item: typeof items.$inferSelect, model: string, generation = 1): Promise<{
	parentHash: string;
	chunks: SemanticChunkRow[];
}> {
	const { parentHash, drafts } = await planSemanticChunks(item, model, generation);

	for (const group of boundedGroups(drafts)) {
		await db.insert(semanticChunks).values(group).onConflictDoUpdate({
			target: semanticChunks.id,
			set: {
				chunkIndex: sql`excluded.chunk_index`,
				chunkText: sql`excluded.chunk_text`,
				parentHash: sql`excluded.parent_hash`,
				generation: sql`excluded.generation`,
				startOffset: sql`excluded.start_offset`,
				endOffset: sql`excluded.end_offset`,
				updatedAt: sql`excluded.updated_at`,
			},
		}).run();
	}
	if (drafts.length === 0) return { parentHash, chunks: [] };
	const ids = drafts.map((draft) => draft.id);
	const rows: SemanticChunkRow[] = [];
	for (const group of boundedGroups(ids, 80)) {
		rows.push(...await db.select().from(semanticChunks).where(inArray(semanticChunks.id, group)));
	}
	return { parentHash, chunks: rows };
}

export async function markSemanticChunksComplete(db: AnansiDb, ids: string[], dimensions: number): Promise<void> {
	for (const group of boundedGroups([...new Set(ids)], 80)) {
		if (group.length === 0) continue;
		await db.update(semanticChunks).set({ status: "complete", dimensions, updatedAt: Math.floor(Date.now() / 1000) }).where(inArray(semanticChunks.id, group)).run();
	}
}

/** Removes manifests from an inference that lost the settings-generation race. */
export async function discardSemanticChunks(db: AnansiDb, ids: string[]): Promise<void> {
	const unique = [...new Set(ids)].filter(Boolean);
	if (unique.length === 0) return;
	const now = Math.floor(Date.now() / 1000);
	for (const group of boundedGroups(unique.map((vectorId) => ({ vectorId, createdAt: now })), 16)) {
		await db.insert(semanticVectorDeletions).values(group).onConflictDoNothing().run();
	}
	for (const group of boundedGroups(unique, 80)) {
		await db.delete(semanticChunks).where(inArray(semanticChunks.id, group)).run();
	}
}

/** Queue stale IDs before deleting their D1 rows, so they can never hydrate. */
export async function retireStaleSemanticChunks(db: AnansiDb, itemId: string, activeIds: string[]): Promise<string[]> {
	const active = new Set(activeIds);
	const rows = await db.select().from(semanticChunks).where(eq(semanticChunks.itemId, itemId));
	const stale = rows.filter((row) => !active.has(row.id));
	const legacy = await db.select().from(itemEmbeddings).where(eq(itemEmbeddings.itemId, itemId));
	const vectorIds = [...new Set([...stale.map((row) => row.id), ...legacy.map((row) => row.vectorId)])];
	const now = Math.floor(Date.now() / 1000);
	for (const group of boundedGroups(vectorIds.map((vectorId) => ({ vectorId, createdAt: now })), 16)) {
		await db.insert(semanticVectorDeletions).values(group).onConflictDoNothing().run();
	}
	for (const group of boundedGroups(stale.map((row) => row.id), 80)) {
		if (group.length > 0) await db.delete(semanticChunks).where(inArray(semanticChunks.id, group)).run();
	}
	if (legacy.length > 0) await db.delete(itemEmbeddings).where(eq(itemEmbeddings.itemId, itemId)).run();
	return vectorIds;
}

/** Disable first, then erase all hosted chunk text and queue vector deletion. */
export async function clearSemanticIndex(db: AnansiDb): Promise<string[]> {
	const chunks = await db.select({ id: semanticChunks.id }).from(semanticChunks);
	const legacy = await db.select({ vectorId: itemEmbeddings.vectorId }).from(itemEmbeddings);
	const vectorIds = [...new Set([...chunks.map((row) => row.id), ...legacy.map((row) => row.vectorId)])];
	const now = Math.floor(Date.now() / 1000);
	for (const group of boundedGroups(vectorIds.map((vectorId) => ({ vectorId, createdAt: now })), 16)) {
		await db.insert(semanticVectorDeletions).values(group).onConflictDoNothing().run();
	}
	for (let offset = 0; offset < chunks.length; offset += 80) {
		const ids = chunks.slice(offset, offset + 80).map((row) => row.id);
		if (ids.length > 0) await db.delete(semanticChunks).where(inArray(semanticChunks.id, ids)).run();
	}
	await db.delete(itemEmbeddings).run();
	await db.update(aiEnrichmentJobs).set({ status: "pending", attempts: 0, nextRunAt: 0, leaseUntil: 0, claimToken: null, updatedAt: now }).where(eq(aiEnrichmentJobs.kind, "embedding")).run();
	return vectorIds;
}

export async function semanticVectorDeletionBatch(db: AnansiDb, limit = 80, now = Math.floor(Date.now() / 1000)) {
	return db.select().from(semanticVectorDeletions)
		.where(sql`${semanticVectorDeletions.nextRunAt} <= ${now}`)
		.orderBy(semanticVectorDeletions.createdAt, semanticVectorDeletions.vectorId)
		.limit(Math.min(Math.max(Math.floor(limit), 1), 100));
}

export async function completeSemanticVectorDeletions(db: AnansiDb, ids: string[]): Promise<void> {
	for (const group of boundedGroups([...new Set(ids)], 80)) {
		if (group.length > 0) await db.delete(semanticVectorDeletions).where(inArray(semanticVectorDeletions.vectorId, group)).run();
	}
}

export async function retrySemanticVectorDeletions(db: AnansiDb, ids: string[], now = Math.floor(Date.now() / 1000)): Promise<void> {
	const rows = await db.select().from(semanticVectorDeletions).where(inArray(semanticVectorDeletions.vectorId, [...new Set(ids)]));
	for (const row of rows) {
		const delay = Math.min(86_400, 60 * 2 ** Math.min(row.attempts, 10));
		await db.update(semanticVectorDeletions).set({ attempts: row.attempts + 1, nextRunAt: now + delay })
			.where(eq(semanticVectorDeletions.vectorId, row.vectorId)).run();
	}
}

export async function semanticIndexStats(db: AnansiDb, model: string, generation = 1) {
	const [row] = await db.select({
		indexed: sql<number>`sum(case when status = 'complete' then 1 else 0 end)`,
		pending: sql<number>`sum(case when status != 'complete' then 1 else 0 end)`,
		total: sql<number>`count(*)`,
	}).from(semanticChunks).where(and(eq(semanticChunks.model, model), eq(semanticChunks.generation, generation)));
	return { indexed: Number(row?.indexed ?? 0), pending: Number(row?.pending ?? 0), total: Number(row?.total ?? 0) };
}

export async function estimateSemanticBackfill(db: AnansiDb, model: string) {
	const rows = await db.select().from(items).orderBy(items.savedAt, items.id);
	const settings = (await db.select({ generation: aiSettings.semanticGeneration }).from(aiSettings).where(eq(aiSettings.id, 1)))[0];
	const generation = settings?.generation ?? 1;
	const indexedRows = await db.select({ id: semanticChunks.id, status: semanticChunks.status }).from(semanticChunks)
		.where(and(eq(semanticChunks.model, model), eq(semanticChunks.generation, generation)));
	const indexed = new Map(indexedRows.map((row) => [row.id, row.status]));
	let totalChunks = 0;
	let newChunks = 0;
	let estimatedCredits = 0;
	for (const item of rows) {
		const { drafts } = await planSemanticChunks(item, model, generation);
		totalChunks += drafts.length;
		for (const draft of drafts) {
			if (indexed.get(draft.id) !== "complete") {
				newChunks += 1;
				estimatedCredits += Math.max(1, Math.ceil(draft.chunkText.length / 1_000));
			}
		}
	}
	return { itemCount: rows.length, totalChunks, newChunks, estimatedCredits };
}

