import {
	type AnansiDb,
	aiProgress,
	claimAiJobs,
	completeAiJob,
	failAiJob,
	getAiSettings,
	itemEmbeddings,
	items,
	reconcileAiJobs,
	semanticText,
} from "@anansi/db";
import { AiProviderError, type EmbeddingProvider } from "./ai.ts";
import type { LocalSemanticCache } from "./local-semantic-cache.ts";
import type { SemanticRuntimeSnapshot } from "./semantic-search.ts";

export interface LocalSemanticWorker {
	runOnce(): Promise<void>;
	status(): SemanticRuntimeSnapshot;
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Processes local embedding jobs without ever running local AI tagging. */
export function createLocalSemanticWorker(
	db: AnansiDb,
	cache: LocalSemanticCache,
	provider: EmbeddingProvider,
	batchSize = 4,
): LocalSemanticWorker {
	let running = false;
	const runOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		let providerUnavailable = false;
		let providerFailed = false;
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
			await reconcileAiJobs(db, Math.max(batchSize, 1) * 4, provider.model);
			const progressBefore = await aiProgress(db, "embedding");
			cache.setStatus({
				state: "warming",
				pending: progressBefore.pending,
				indexed: cache.snapshot().indexed,
				dimension: provider.dimensions || undefined,
			});
			const jobs = await claimAiJobs(
				db,
				"embedding",
				Math.min(Math.max(batchSize, 1), 20),
			);
			for (const job of jobs) {
				try {
					const item = (await db.select().from(items)).find(
						(candidate) => candidate.id === job.itemId,
					);
					if (!item) {
						await cache.invalidate([job.itemId]);
						await completeAiJob(db, job.id, job.token);
						continue;
					}
					const values = await provider.embed(semanticText(item));
					await cache.upsertRecords([
						{ id: item.id, contentHash: job.contentHash, values },
					]);
					const timestamp = Math.floor(Date.now() / 1000);
					await db
						.insert(itemEmbeddings)
						.values({
							itemId: item.id,
							vectorId: item.id,
							model: provider.model,
							dimensions: values.length,
							contentHash: job.contentHash,
							status: "complete",
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.onConflictDoUpdate({
							target: itemEmbeddings.itemId,
							set: {
								vectorId: item.id,
								model: provider.model,
								dimensions: values.length,
								contentHash: job.contentHash,
								status: "complete",
								updatedAt: timestamp,
								lastError: null,
							},
						});
					await completeAiJob(db, job.id, job.token);
				} catch (error) {
					if (error instanceof AiProviderError) {
						if (error.code === "unavailable") providerUnavailable = true;
						else providerFailed = true;
					}
					await failAiJob(
						db,
						job.id,
						job.token,
						job.attempts,
						safeError(error),
					);
					const progress = await aiProgress(db, "embedding");
					cache.setStatus({
						state: providerUnavailable ? "unavailable" : "error",
						pending: progress.pending,
						indexed: cache.snapshot().indexed,
						dimension: provider.dimensions || undefined,
						errorCode: "embedding-failed",
					});
				}
			}
			const progress = await aiProgress(db, "embedding");
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
