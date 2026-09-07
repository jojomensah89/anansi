import {
	applyAiTags,
	aiProgress,
	claimAiJobs,
	completeAiJob,
	failAiJob,
	getAiSettings,
	reconcileAiJobs,
	searchableText,
	items,
	type AnansiDb,
} from "@anansi/db";
import type { TagGenerationProvider } from "./ai.ts";

export interface LocalTaggingWorker {
	runOnce(): Promise<void>;
	status(): Promise<{ pending: number; failed: number; complete: number }>;
}
function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Processes local tagging jobs without coupling inference to ingest. */
export function createLocalTaggingWorker(
	db: AnansiDb,
	provider: TagGenerationProvider,
	batchSize = 2,
): LocalTaggingWorker {
	let running = false;
	const runOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const settings = await getAiSettings(db);
			if (!settings.autoTaggingEnabled) return;
			await reconcileAiJobs(db, Math.max(batchSize, 1) * 4, undefined, ["tagging"]);
			const canonicalItems = await db.select().from(items);
			const jobs = await claimAiJobs(db, "tagging", Math.min(Math.max(batchSize, 1), 20));
			for (const job of jobs) {
				try {
					const item = canonicalItems.find((candidate) => candidate.id === job.itemId);
					if (!item) {
						await completeAiJob(db, job.id, job.token);
						continue;
					}
					const labels = await provider.generateTags(searchableText(item));
					await applyAiTags(db, item.id, labels, provider.model);
					await completeAiJob(db, job.id, job.token);
				} catch (error) {
					await failAiJob(db, job.id, job.token, job.attempts, safeError(error));
				}
			}
		} finally {
			running = false;
		}
	};

	return {
		runOnce,
		status: () => aiProgress(db, "tagging"),
	};
}
