import {
	type AnansiDb,
	type DbItem,
	type SemanticChunkRow,
	completeSemanticVectorDeletions,
	consumeSemanticCredits,
	discardSemanticChunks,
	getAiSettings,
	markSemanticChunksComplete,
	retireStaleSemanticChunks,
	stageSemanticChunks,
} from "@anansi/db";
import { AiProviderError, type EmbeddingProvider, type VectorIndex } from "./ai.ts";
import type { LocalSemanticCache } from "./local-semantic-cache.ts";

export interface PreparedSemanticItem {
	parentHash: string;
	generation: number;
	chunks: SemanticChunkRow[];
	vectors: Array<{ id: string; contentHash: string; values: number[] }>;
}

export async function prepareSemanticItems(
	db: AnansiDb,
	items: readonly DbItem[],
	provider: EmbeddingProvider,
	options: { hosted?: boolean; localCache?: LocalSemanticCache } = {},
): Promise<PreparedSemanticItem[]> {
	if (items.length === 0) return [];
	const settings = await getAiSettings(db);
	if (settings.semanticSearchEnabled !== 1 || settings.semanticIndexPaused === 1) {
		return items.map(() => ({ parentHash: "", generation: settings.semanticGeneration, chunks: [], vectors: [] }));
	}
	const staged: Array<{ parentHash: string; chunks: SemanticChunkRow[] }> = [];
	for (const item of items) {
		staged.push(await stageSemanticChunks(db, item, provider.model, settings.semanticGeneration));
	}
	const current = await getAiSettings(db);
	if (current.semanticSearchEnabled !== 1 || current.semanticIndexPaused === 1 || current.semanticGeneration !== settings.semanticGeneration || current.embeddingModel !== provider.model) {
		await discardSemanticChunks(db, staged.flatMap(({ chunks }) => chunks.map((chunk) => chunk.id)));
		return staged.map(({ parentHash }) => ({ parentHash, generation: settings.semanticGeneration, chunks: [], vectors: [] }));
	}
	const prepared = staged.map(({ parentHash, chunks }) => ({
		parentHash,
		generation: settings.semanticGeneration,
		chunks: [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex || a.id.localeCompare(b.id)),
		vectors: [] as PreparedSemanticItem["vectors"],
	}));
	const pending = prepared.flatMap((entry, itemIndex) => entry.chunks
		.filter((chunk) =>
			chunk.status !== "complete" ||
			(options.localCache && !options.localCache.hasRecord(chunk.id, chunk.contentHash)),
		)
		.map((chunk) => ({ itemIndex, chunk })));
	for (let offset = 0; offset < pending.length; offset += 16) {
		const batch = pending.slice(offset, offset + 16);
		if (options.hosted) {
			const budget = await consumeSemanticCredits(db, batch.map(({ chunk }) => chunk.chunkText));
			if (!budget.allowed) throw new AiProviderError("quota", "monthly semantic credit cap reached");
		}
		const embeddings = provider.embedBatch
			? await provider.embedBatch(batch.map(({ chunk }) => chunk.chunkText))
			: await Promise.all(batch.map(({ chunk }) => provider.embed(chunk.chunkText)));
		if (!Array.isArray(embeddings) || embeddings.length !== batch.length) throw new AiProviderError("malformed", "embedding provider returned an incomplete chunk batch");
		for (let index = 0; index < batch.length; index += 1) {
			const { itemIndex, chunk } = batch[index]!;
			const values = embeddings[index]!;
			if (!Array.isArray(values) || values.length !== provider.dimensions || values.some((value) => !Number.isFinite(value))) {
				throw new AiProviderError("dimension", "embedding provider returned an invalid chunk vector");
			}
			prepared[itemIndex]!.vectors.push({ id: chunk.id, contentHash: chunk.contentHash, values });
		}
	}
	return prepared;
}

export async function prepareSemanticItem(
	db: AnansiDb,
	item: DbItem,
	provider: EmbeddingProvider,
	options: { hosted?: boolean; localCache?: LocalSemanticCache } = {},
): Promise<PreparedSemanticItem> {
	const [prepared] = await prepareSemanticItems(db, [item], provider, options);
	if (!prepared) throw new Error("semantic item preparation returned no result");
	return prepared;
}

export async function publishSemanticItem(
	db: AnansiDb,
	itemId: string,
	prepared: PreparedSemanticItem,
	options: { index?: VectorIndex; localCache?: LocalSemanticCache } = {},
): Promise<void> {
	const beforePublish = await getAiSettings(db);
	if (beforePublish.semanticSearchEnabled !== 1 || beforePublish.semanticIndexPaused === 1 || beforePublish.semanticGeneration !== prepared.generation || prepared.chunks.some((chunk) => chunk.model !== beforePublish.embeddingModel)) {
		await discardSemanticChunks(db, prepared.chunks.map((chunk) => chunk.id));
		return;
	}
	if (options.localCache && prepared.vectors.length > 0) {
		await options.localCache.upsertRecords(prepared.vectors.map((vector) => ({
			id: vector.id,
			contentHash: vector.contentHash,
			values: vector.values,
		})));
	} else if (prepared.vectors.length > 0 && options.index) {
		await options.index.upsert(prepared.vectors.map(({ id, values }) => ({ id, values })));
	}
	const afterPublish = await getAiSettings(db);
	if (afterPublish.semanticSearchEnabled !== 1 || afterPublish.semanticIndexPaused === 1 || afterPublish.semanticGeneration !== prepared.generation || afterPublish.embeddingModel !== beforePublish.embeddingModel) {
		const ids = prepared.chunks.map((chunk) => chunk.id);
		await discardSemanticChunks(db, ids);
		const deleteIndex = options.localCache ?? options.index;
		if (deleteIndex?.deleteByIds && ids.length > 0) {
			try {
				await deleteIndex.deleteByIds(ids);
				await completeSemanticVectorDeletions(db, ids);
			} catch { /* durable vector tombstones retry in the background */ }
		}
		return;
	}
	await markSemanticChunksComplete(db, prepared.vectors.map((vector) => vector.id), prepared.vectors[0]?.values.length ?? options.localCache?.dimensions ?? options.index?.dimensions ?? 0);
	const staleIds = await retireStaleSemanticChunks(db, itemId, prepared.chunks.map((chunk) => chunk.id));
	if (staleIds.length === 0) return;
	const deleteIndex = options.localCache ?? options.index;
	if (!deleteIndex?.deleteByIds) return;
	try {
		await deleteIndex.deleteByIds(staleIds);
		await completeSemanticVectorDeletions(db, staleIds);
	} catch {
		// D1 has already removed the stale manifests, so failed remote cleanup
		// cannot produce a visible result. The durable tombstones retry on cron.
	}
}
