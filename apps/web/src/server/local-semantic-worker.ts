import {
	type AiJob,
	type AnansiDb,
	type DbItem,
	aiProgress,
	getAiSettings,
	items,
	requeueEmbeddingJobs,
	stageSemanticChunks,
} from "@anansi/db";
import { AiProviderError, type EmbeddingProvider } from "./ai.ts";
import { createAiJobRunner } from "./ai-job-runner.ts";
import type { LocalSemanticCache } from "./local-semantic-cache.ts";
import type { SemanticRuntimeSnapshot } from "./semantic-search.ts";
import {
	prepareSemanticItem,
	prepareSemanticItems,
	publishSemanticItem,
} from "./semantic-embedding.ts";
import { drainSemanticVectorDeletes } from "./semantic-vector-cleanup.ts";

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
			await drainSemanticVectorDeletes(db, cache, batchSize * 4);
			const settings = await getAiSettings(db);
			if (!settings.semanticSearchEnabled || settings.semanticIndexPaused) {
				cache.setStatus({
					state: settings.semanticSearchEnabled ? "paused" : "warming",
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
				const staged = await stageSemanticChunks(db, item, provider.model, settings.semanticGeneration);
				if (staged.chunks.some((chunk) => !cache.hasRecord(chunk.id, chunk.contentHash))) {
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
			const runner = createAiJobRunner({
				db,
				batchSize,
				reconcile: { limit: Math.max(batchSize, 1) * 4, model: provider.model },
				executor: {
					kind: "embedding",
					model: provider.model,
					onMissingItem: async () => {
						await drainSemanticVectorDeletes(db, cache, batchSize * 4);
					},
					prepare: async (item) => {
						try {
							return await prepareSemanticItem(db, item, provider, { localCache: cache });
						} catch (error) {
							observeProviderError(error);
							throw error;
						}
					},
					...(provider.embedBatch
						? {
							prepareBatch: async (
								entries: readonly { item: DbItem; job: AiJob }[],
							) => {
								try {
									return await prepareSemanticItems(
										db,
										entries.map(({ item }) => item),
										provider,
										{ localCache: cache },
									);
								} catch (error) {
									observeProviderError(error);
									throw error;
								}
							},
						}
						: {}),
					publish: async (item, _job, prepared) => {
						try {
							await publishSemanticItem(db, item.id, prepared, { localCache: cache });
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
