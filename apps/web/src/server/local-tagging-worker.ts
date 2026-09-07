import {
	applyAiTags,
	aiProgress,
	getAiSettings,
	searchableText,
	type AnansiDb,
} from "@anansi/db";
import { createAiJobRunner } from "./ai-job-runner.ts";
import type { TagGenerationProvider } from "./ai.ts";

export interface LocalTaggingWorker {
	runOnce(): Promise<void>;
	status(): Promise<{ pending: number; failed: number; complete: number }>;
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
			const runner = createAiJobRunner({
				db,
				batchSize,
				reconcile: { limit: Math.max(batchSize, 1) * 4 },
				executor: {
					kind: "tagging",
					model: provider.model,
					prepare: async (item) => provider.generateTags(searchableText(item)),
					publish: async (item, _job, labels) => {
						await applyAiTags(db, item.id, labels, provider.model);
					},
				},
			});
			await runner.runOnce();
		} finally {
			running = false;
		}
	};

	return {
		runOnce,
		status: () => aiProgress(db, "tagging", provider.model),
	};
}
