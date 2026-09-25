import {
	type AiJob,
	type AnansiDb,
	aiProgress,
	contentHash,
	type DbItem,
	getAiSettings,
	items,
	requeueEmbeddingJobs,
	semanticText,
	upsertItemEmbedding,
} from "@anansi/db";
import { AiProviderError, type EmbeddingProvider } from "./ai.ts";
import { createAiJobRunner } from "./ai-job-runner.ts";
import type { LocalSemanticCache } from "./local-semantic-cache.ts";
import type { SemanticRuntimeSnapshot } from "./semantic-search.ts";

export interface LocalSemanticWorker {
	runOnce(): Promise<void>;
	status(): SemanticRuntimeSnapshot;
}
/** Processes local embedding jobs without ever running local AI tagging. */
export function createLocalSemanticWorker(
	db: AnansiDb,
	cache: LocalSemanticCache,
	provider: EmbeddingProvider,
	batchSize = 64,
): LocalSemanticWorker {
	let running = false;
	let firstRun = true;
	const runOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		let providerUnavailable = false;
		let providerFailed = false;
		const observeProviderError = (error: unknown) => {
			if (error instanceof AiProviderError) {
				if (error.code === "unavailable") providerUnavailable = true;
				else providerFailed = true;
			}
		};
		try {
			const settings = await getAiSettings(db);
			if (!settings.semanticSearchEnabled) {
				cache.setStatus({
					state: "warming",
					pending: 0,
					indexed: cache.snapshot().indexed,
				});
				return;
			}
			cache.replaceGeneration(provider.model);
			// A sidecar can be removed or rebuilt independently of the canonical
			// database. Reopen completed jobs whose current projection is absent (or
			// stale), and drop stale vectors before they can affect search.
			const canonicalItems = await db.select().from(items);
			const missingVectors: string[] = [];
			for (const item of canonicalItems) {
				const hash = await contentHash(semanticText(item));
				if (!cache.hasRecord(item.id, hash)) {
					if (cache.recordHash(item.id)) await cache.invalidate([item.id]);
					missingVectors.push(item.id);
				}
			}
			await requeueEmbeddingJobs(db, missingVectors, provider.model, firstRun);
			firstRun = false;
			const progressBefore = await aiProgress(db, "embedding", provider.model);
			cache.setStatus({
				state: "warming",
				pending: progressBefore.pending,
				indexed: cache.snapshot().indexed,
				dimension: provider.dimensions || undefined,
			});
			const embedBatch = provider.embedBatch?.bind(provider);
			const runner = createAiJobRunner({
				db,
				batchSize,
				reconcile: { limit: Math.max(batchSize, 1) * 4, model: provider.model },
				executor: {
					kind: "embedding",
					model: provider.model,
					onMissingItem: (job) => cache.invalidate([job.itemId]),
					prepare: async (item) => {
						try {
							return await provider.embed(semanticText(item));
						} catch (error) {
							observeProviderError(error);
							throw error;
						}
					},
					...(embedBatch
						? {
								prepareBatch: async (
									entries: readonly { item: DbItem; job: AiJob }[],
								) => {
									try {
										return await embedBatch(
											entries.map(({ item }) => semanticText(item)),
										);
									} catch (error) {
										observeProviderError(error);
										throw error;
									}
								},
								publishBatch: async (
									entries: readonly {
										item: DbItem;
										job: AiJob;
										prepared: number[];
									}[],
								) => {
									await cache.upsertRecords(
										entries.map(({ item, job, prepared }) => ({
											id: item.id,
											contentHash: job.contentHash,
											values: prepared,
										})),
									);
									for (const { item, job, prepared } of entries) {
										await upsertItemEmbedding(db, {
											itemId: item.id,
											model: provider.model,
											dimensions: prepared.length,
											contentHash: job.contentHash,
										});
									}
								},
							}
						: {}),
					publish: async (item, job, values) => {
						try {
							await cache.upsertRecords([
								{ id: item.id, contentHash: job.contentHash, values },
							]);
							await upsertItemEmbedding(db, {
								itemId: item.id,
								model: provider.model,
								dimensions: values.length,
								contentHash: job.contentHash,
							});
						} catch (error) {
							observeProviderError(error);
							throw error;
						}
					},
				},
			});
			await runner.runUntilIdle();
			const progress = await aiProgress(db, "embedding", provider.model);
			const snapshot = cache.snapshot();
			cache.setStatus({
				state: providerUnavailable
					? "unavailable"
					: providerFailed
						? "error"
						: progress.failed > 0
							? "paused"
							: progress.pending > 0
								? "warming"
								: "ready",
				pending: progress.pending,
				indexed: snapshot.indexed,
				dimension: provider.dimensions || snapshot.dimension,
				...(providerUnavailable || providerFailed || progress.failed > 0
					? { errorCode: "embedding-failed" }
					: {}),
			});
		} finally {
			running = false;
		}
	};

	return {
		runOnce,
		status: () => cache.snapshot(),
	};
}
