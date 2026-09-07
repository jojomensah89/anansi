import { type AnansiDb, aiSettings } from "@anansi/db";

export interface LocalAiModels {
	embeddingModel: string;
	tagModel: string;
}

/**
 * Makes the local provider identities authoritative without touching the
 * user's feature toggles. The upsert is one local SQLite transaction so a
 * worker never observes a half-updated pair during startup.
 */
export function syncLocalAiModels(db: AnansiDb, models: LocalAiModels): void {
	const embeddingModel = models.embeddingModel.trim();
	const tagModel = models.tagModel.trim();
	if (!embeddingModel || !tagModel) {
		throw new Error("Local AI models must be non-empty");
	}
	const updatedAt = Math.floor(Date.now() / 1000);
	db.transaction((transaction) => {
		transaction
			.insert(aiSettings)
			.values({ id: 1, embeddingModel, tagModel, updatedAt })
			.onConflictDoUpdate({
				target: aiSettings.id,
				set: { embeddingModel, tagModel, updatedAt },
			})
			.run();
	});
}
