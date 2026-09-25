import {
	type AiJob,
	type AiJobFailureCode,
	type AiJobKind,
	type AnansiDb,
	claimAiJobs,
	completeAiJob,
	contentHash,
	type DbItem,
	embeddingProjectionText,
	failAiJob,
	getAiSettings,
	loadAiJobItems,
	reconcileAiJobs,
	releaseAiJob,
	searchableText,
	validateAiJobClaim,
} from "@anansi/db";

export interface AiJobExecutor<Prepared = unknown> {
	kind: AiJobKind;
	/** Every job generation is model-qualified, including tagging. */
	model: string;
	/** Performs provider inference only; it must not publish a projection. */
	prepare(item: DbItem, job: AiJob): Promise<Prepared>;
	/** Optional provider batch path. Results must preserve input order. */
	prepareBatch?(
		entries: readonly { item: DbItem; job: AiJob }[],
	): Promise<readonly Prepared[]>;
	/** Publishes a prepared result after the runner's final item/claim checks. */
	publish(item: DbItem, job: AiJob, prepared: Prepared): Promise<void>;
	/** Optional atomic sidecar write after every entry passes final fencing. */
	publishBatch?(
		entries: readonly { item: DbItem; job: AiJob; prepared: Prepared }[],
	): Promise<void>;
	/** Preserve sidecar cleanup while the runner owns missing-item acknowledgement. */
	onMissingItem?(job: AiJob): Promise<void>;
}

export interface AiJobRunnerOptions<Prepared = unknown> {
	db: AnansiDb;
	executor: AiJobExecutor<Prepared>;
	batchSize?: number;
	/** Disabled capabilities leave queued work untouched and unclaimed. */
	enabled?: boolean;
	/** Reconciliation is optional so one runtime invocation can reconcile both kinds once. */
	reconcile?: { limit: number; model?: string };
}

export interface AiJobRunOutcome {
	claimed: number;
	completed: number;
	retrying: number;
	failed: number;
	skipped: number;
}

function emptyOutcome(): AiJobRunOutcome {
	return {
		claimed: 0,
		completed: 0,
		retrying: 0,
		failed: 0,
		skipped: 0,
	};
}

const FAILURE_CODES = new Set<AiJobFailureCode>([
	"quota",
	"unavailable",
	"malformed",
	"dimension",
	"unknown",
]);

export function classifyAiJobFailure(error: unknown): AiJobFailureCode {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (
			typeof code === "string" &&
			FAILURE_CODES.has(code as AiJobFailureCode)
		) {
			return code as AiJobFailureCode;
		}
	}
	return "unknown";
}

function textFor(kind: AiJobKind, item: DbItem, semanticGeneration: number): string {
	return kind === "embedding" ? embeddingProjectionText(item, semanticGeneration) : searchableText(item);
}

function currentModel(job: AiJob, kind: AiJobKind, model: string): boolean {
	return job.id.startsWith(`${kind}:${model}:`);
}

function activeGeneration(
	settings: Awaited<ReturnType<typeof getAiSettings>>,
	kind: AiJobKind,
): { enabled: boolean; model: string } {
	return kind === "embedding"
		? {
			enabled: settings.semanticSearchEnabled === 1 && settings.semanticIndexPaused !== 1,
				model: settings.embeddingModel,
			}
		: { enabled: settings.autoTaggingEnabled === 1, model: settings.tagModel };
}

/**
 * Runs a bounded AI batch. Single-item executors claim only when work can begin;
 * batch executors claim exactly the bounded group they immediately submit. The
 * provider result is prepared first, then each item and claim is reloaded before
 * publication. Remote publication and local acknowledgement are not atomic, so
 * adapters must make publication idempotent.
 */
export function createAiJobRunner<Prepared = unknown>({
	db,
	executor,
	batchSize = 4,
	enabled = true,
	reconcile: reconcileConfig,
}: AiJobRunnerOptions<Prepared>) {
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 100);
	const kind = executor.kind;

	const runOnce = async ({
		reconcile: shouldReconcile = true,
	}: {
		reconcile?: boolean;
	} = {}): Promise<AiJobRunOutcome> => {
		if (enabled === false) return emptyOutcome();
		if (reconcileConfig && shouldReconcile) {
			await reconcileAiJobs(
				db,
				reconcileConfig.limit,
				reconcileConfig.model ?? executor.model,
				[kind],
			);
		}
		const outcome = emptyOutcome();

		const recordFailure = async (
			job: AiJob,
			error: unknown,
		): Promise<boolean> => {
			const code = classifyAiJobFailure(error);
			const transitioned = await failAiJob(
				db,
				job.id,
				job.token,
				job.attempts,
				code,
			);
			if (!transitioned) {
				outcome.skipped += 1;
			} else if (
				code === "malformed" ||
				code === "dimension" ||
				(code === "unknown" && job.attempts >= 5)
			) {
				outcome.failed += 1;
			} else {
				outcome.retrying += 1;
			}
			return transitioned;
		};

		const acknowledgeSkipped = async (job: AiJob) => {
			// A stale item is deliberately acknowledged so reconciliation can
			// enqueue its new hash. If the claim was lost or its lease expired,
			// this is a no-op: the row remains reclaimable rather than being
			// incorrectly completed as skipped.
			await completeAiJob(db, job.id, job.token);
			outcome.skipped += 1;
		};

		const reconcileActiveGeneration = async (
			settings: Awaited<ReturnType<typeof getAiSettings>>,
		) => {
			if (!reconcileConfig) return;
			const generation = activeGeneration(settings, kind);
			if (!generation.enabled) return;
			await reconcileAiJobs(db, reconcileConfig.limit, generation.model, [
				kind,
			]);
		};

		if (executor.prepareBatch) {
			const jobs = await claimAiJobs(
				db,
				kind,
				limit,
				undefined,
				executor.model,
			);
			outcome.claimed = jobs.length;
			if (jobs.length === 0) return outcome;

			let loaded: DbItem[];
			try {
				loaded = await loadAiJobItems(
					db,
					jobs.map((job) => job.itemId),
				);
			} catch (error) {
				for (const job of jobs) await recordFailure(job, error);
				return outcome;
			}
			const itemsById = new Map(loaded.map((item) => [item.id, item]));
			const entries: { item: DbItem; job: AiJob }[] = [];
			for (const job of jobs) {
				const item = itemsById.get(job.itemId);
				if (item) {
					entries.push({ item, job });
					continue;
				}
				try {
					await executor.onMissingItem?.(job);
					await completeAiJob(db, job.id, job.token);
					outcome.skipped += 1;
				} catch (error) {
					await recordFailure(job, error);
				}
			}
			if (entries.length === 0) return outcome;

			let prepared: readonly Prepared[];
			try {
				prepared = await executor.prepareBatch(entries);
				if (prepared.length !== entries.length) {
					throw { code: "malformed" };
				}
			} catch (error) {
				for (const { job } of entries) await recordFailure(job, error);
				return outcome;
			}

			const publishable: { item: DbItem; job: AiJob; prepared: Prepared }[] =
				[];
			for (let index = 0; index < entries.length; index += 1) {
				const { job } = entries[index]!;
				try {
					const latest = (await loadAiJobItems(db, [job.itemId]))[0];
					const settings = await getAiSettings(db);
					const latestHash = latest
						? await contentHash(textFor(kind, latest, settings.semanticGeneration))
						: undefined;
					const generation = activeGeneration(settings, kind);
					const claimLive = await validateAiJobClaim(db, job.id, job.token);
					if (!generation.enabled || generation.model !== executor.model) {
						await reconcileActiveGeneration(settings);
						await releaseAiJob(db, job.id, job.token, job.attempts);
						outcome.skipped += 1;
						continue;
					}
					if (
						!latest ||
						latestHash !== job.contentHash ||
						!currentModel(job, kind, executor.model) ||
						!claimLive
					) {
						await acknowledgeSkipped(job);
						continue;
					}
					publishable.push({ item: latest, job, prepared: prepared[index]! });
				} catch (error) {
					await recordFailure(job, error);
				}
			}

			if (executor.publishBatch && publishable.length > 0) {
				try {
					await executor.publishBatch(publishable);
					for (const { job } of publishable) {
						if (await completeAiJob(db, job.id, job.token))
							outcome.completed += 1;
						else outcome.skipped += 1;
					}
				} catch (error) {
					for (const { job } of publishable) await recordFailure(job, error);
				}
				return outcome;
			}

			for (const { item, job, prepared: value } of publishable) {
				try {
					await executor.publish(item, job, value);
					if (await completeAiJob(db, job.id, job.token))
						outcome.completed += 1;
					else outcome.skipped += 1;
				} catch (error) {
					await recordFailure(job, error);
				}
			}
			return outcome;
		}

		for (let index = 0; index < limit; index += 1) {
			const [job] = await claimAiJobs(db, kind, 1, undefined, executor.model);
			if (!job) break;
			outcome.claimed += 1;

			let item: DbItem | undefined;
			try {
				item = (await loadAiJobItems(db, [job.itemId]))[0];
			} catch (error) {
				if (!(await recordFailure(job, error))) break;
				continue;
			}

			if (!item) {
				try {
					await executor.onMissingItem?.(job);
					await completeAiJob(db, job.id, job.token);
					outcome.skipped += 1;
				} catch (error) {
					if (!(await recordFailure(job, error))) break;
				}
				continue;
			}

			let prepared: Prepared;
			try {
				prepared = await executor.prepare(item, job);
			} catch (error) {
				if (!(await recordFailure(job, error))) break;
				continue;
			}

			try {
				const latest = (await loadAiJobItems(db, [job.itemId]))[0];
				// Read settings before the final claim check. A model/toggle change
				// during inference must be observed while the lease is still live.
				const settings = await getAiSettings(db);
			const latestHash = latest
				? await contentHash(textFor(kind, latest, settings.semanticGeneration))
				: undefined;
				const generation = activeGeneration(settings, kind);
				const claimLive = await validateAiJobClaim(db, job.id, job.token);
				const settingsMismatch =
					!generation.enabled || generation.model !== executor.model;
				if (settingsMismatch) {
					await reconcileActiveGeneration(settings);
					// Configuration changes are not provider failures. Return the
					// claim to pending (including its attempt budget) and stop this
					// batch so it cannot immediately reclaim and spin on the same row.
					await releaseAiJob(db, job.id, job.token, job.attempts);
					outcome.skipped += 1;
					break;
				}
				if (
					!latest ||
					latestHash !== job.contentHash ||
					!currentModel(job, kind, executor.model) ||
					!claimLive
				) {
					await acknowledgeSkipped(job);
					// Do not immediately reclaim the same expired row in this
					// invocation. Its disposition belongs to a later worker.
					if (!claimLive) break;
					continue;
				}
				await executor.publish(latest, job, prepared);
				if (await completeAiJob(db, job.id, job.token)) outcome.completed += 1;
				else outcome.skipped += 1;
			} catch (error) {
				if (!(await recordFailure(job, error))) break;
			}
		}
		return outcome;
	};

	const runUntilIdle = async (): Promise<AiJobRunOutcome> => {
		const total = emptyOutcome();
		let shouldReconcile = true;
		while (true) {
			const outcome = await runOnce({ reconcile: shouldReconcile });
			total.claimed += outcome.claimed;
			total.completed += outcome.completed;
			total.retrying += outcome.retrying;
			total.failed += outcome.failed;
			total.skipped += outcome.skipped;

			if (outcome.claimed > 0) {
				// A settings fence can release the same claim as immediately
				// pending. Do not reclaim it in a tight loop when the batch made
				// no forward progress.
				if (outcome.completed + outcome.retrying + outcome.failed === 0) {
					return total;
				}
				// Reconciliation is intentionally skipped between batches. Once
				// the current bounded queue is empty, the next pass refills it.
				shouldReconcile = false;
				continue;
			}
			if (!shouldReconcile) {
				shouldReconcile = true;
				continue;
			}
			return total;
		}
	};

	return { runOnce, runUntilIdle };
}

export type AiJobRunner = ReturnType<typeof createAiJobRunner>;
