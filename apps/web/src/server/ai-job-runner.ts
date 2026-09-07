import {
	type AiJob,
	type AiJobFailureCode,
	type AiJobKind,
	type AnansiDb,
	claimAiJobs,
	completeAiJob,
	contentHash,
	type DbItem,
	failAiJob,
	getAiSettings,
	loadAiJobItems,
	reconcileAiJobs,
	releaseAiJob,
	searchableText,
	semanticText,
	validateAiJobClaim,
} from "@anansi/db";

export interface AiJobExecutor<Prepared = unknown> {
	kind: AiJobKind;
	/** Every job generation is model-qualified, including tagging. */
	model: string;
	/** Performs provider inference only; it must not publish a projection. */
	prepare(item: DbItem, job: AiJob): Promise<Prepared>;
	/** Publishes a prepared result after the runner's final item/claim checks. */
	publish(item: DbItem, job: AiJob, prepared: Prepared): Promise<void>;
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

function textFor(kind: AiJobKind, item: DbItem): string {
	return kind === "embedding" ? semanticText(item) : searchableText(item);
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
				enabled: settings.semanticSearchEnabled === 1,
				model: settings.embeddingModel,
			}
		: { enabled: settings.autoTaggingEnabled === 1, model: settings.tagModel };
}

/**
 * Runs a bounded AI batch. Jobs are claimed one at a time so a slow provider
 * cannot consume the leases of work waiting behind it. The provider result is
 * prepared first, then the item and claim are reloaded immediately before
 * publication. Remote publication and the local acknowledgement are not one
 * atomic operation; adapters must therefore make publication idempotent.
 */
export function createAiJobRunner<Prepared = unknown>({
	db,
	executor,
	batchSize = 4,
	enabled = true,
	reconcile,
}: AiJobRunnerOptions<Prepared>) {
	const limit = Math.min(Math.max(batchSize, 1), 20);
	const kind = executor.kind;

	return {
		async runOnce(): Promise<AiJobRunOutcome> {
			const disabled: AiJobRunOutcome = {
				claimed: 0,
				completed: 0,
				retrying: 0,
				failed: 0,
				skipped: 0,
			};
			if (enabled === false) return disabled;
			if (reconcile) {
				await reconcileAiJobs(
					db,
					reconcile.limit,
					reconcile.model ?? executor.model,
					[kind],
				);
			}
			const outcome: AiJobRunOutcome = {
				claimed: 0,
				completed: 0,
				retrying: 0,
				failed: 0,
				skipped: 0,
			};

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
				if (!reconcile) return;
				const generation = activeGeneration(settings, kind);
				if (!generation.enabled) return;
				await reconcileAiJobs(db, reconcile.limit, generation.model, [kind]);
			};

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
					const latestHash = latest
						? await contentHash(textFor(kind, latest))
						: undefined;
					// Read settings before the final claim check. A model/toggle change
					// during inference must be observed while the lease is still live.
					const settings = await getAiSettings(db);
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
					if (await completeAiJob(db, job.id, job.token))
						outcome.completed += 1;
					else outcome.skipped += 1;
				} catch (error) {
					if (!(await recordFailure(job, error))) break;
				}
			}
			return outcome;
		},
	};
}

export type AiJobRunner = ReturnType<typeof createAiJobRunner>;
