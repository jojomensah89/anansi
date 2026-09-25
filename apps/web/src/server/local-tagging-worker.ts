import {
	applyAiTags,
	aiProgress,
	getAiSettings,
	reconcileAiJobs,
	searchableText,
	type AnansiDb,
} from "@anansi/db";
import type { TagGenerationProvider } from "./ai.ts";
import { createAiJobRunner } from "./ai-job-runner.ts";

export interface LocalTaggingWorker {
	runOnce(): Promise<void>;
	status(): Promise<{ pending: number; failed: number; complete: number }>;
}

type TaggingPreparation = { labels: string[] } | { error: unknown };

/** Processes local tagging jobs without coupling inference to ingest. */
export function createLocalTaggingWorker(
	db: AnansiDb,
	provider: TagGenerationProvider,
	queueChunk = 50,
	concurrency = 1,
): LocalTaggingWorker {
	const roundLimit = Math.min(Math.max(Math.trunc(queueChunk), 1), 100);
	const workerLimit = Math.min(Math.max(Math.trunc(concurrency), 1), 4);
	let running = false;
	const runOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		let providerUnavailable = false;
		try {
			const settings = await getAiSettings(db);
			if (!settings.autoTaggingEnabled) return;
			await reconcileAiJobs(db, roundLimit * 4, provider.model, ["tagging"]);
			const createRunner = (batchSize: number) =>
				createAiJobRunner<TaggingPreparation>({
					db,
					batchSize,
					executor: {
						kind: "tagging",
						model: provider.model,
						prepare: async () => ({ labels: [] as string[] }),
						prepareBatch: (entries) =>
							Promise.all(
								entries.map(async ({ item }) => {
									try {
										return {
											labels: await provider.generateTags(searchableText(item)),
										};
									} catch (error) {
										if (
											typeof error === "object" &&
											error !== null &&
											"code" in error &&
											error.code === "unavailable"
										) {
											providerUnavailable = true;
										}
										return { error };
									}
								}),
							),
						publish: async (item, _job, result) => {
							if ("error" in result) throw result.error;
							await applyAiTags(db, item.id, result.labels, provider.model);
						},
					},
				});
			while (!providerUnavailable) {
				let processedThisRound = 0;
				while (processedThisRound < roundLimit && !providerUnavailable) {
					const runner = createRunner(
						Math.min(workerLimit, roundLimit - processedThisRound),
					);
					const outcome = await runner.runOnce({ reconcile: false });
					const claimed = outcome.claimed;
					processedThisRound += claimed;
					if (claimed === 0) break;
				}
				if (providerUnavailable) return;
				if (
					(await reconcileAiJobs(db, roundLimit * 4, provider.model, [
						"tagging",
					])) === 0
				) {
					return;
				}
			}
		} finally {
			running = false;
		}
	};

	return {
		runOnce,
		status: () => aiProgress(db, "tagging", provider.model),
	};
}
