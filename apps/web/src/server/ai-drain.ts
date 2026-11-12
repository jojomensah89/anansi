import {
	type AiJobFailureCode,
	type AiJobKind,
	type AiSourceItem,
	type AnansiDb,
	type ClaimedAiJob,
	type SemanticChunkDraft,
	claimDueAiJobs,
	completeClaimedAiJobs,
	completeSemanticVectorDeletions,
	consumeSemanticCredits,
	contentHash,
	deleteClaimedAiJobs,
	discardSemanticChunks,
	embeddingProjectionText,
	failClaimedAiJobs,
	getAiSettings,
	insertClaimedAiJobs,
	itemsWithStaleSemanticRows,
	loadAiSourceItems,
	markSemanticChunksCompleteBulk,
	planSemanticChunks,
	publishAiTags,
	releaseClaimedAiJobs,
	retireStaleSemanticChunks,
	searchableText,
	stageSemanticChunksBulk,
	topicDefinition,
	unqueuedAiItems,
} from "@anansi/db";
import { AiProviderError, type AiBinding, type VectorizeBinding, createVectorIndex, embedBatch, generateTagsBatch } from "./ai.ts";
import { classifyAiJobFailure } from "./ai-job-runner.ts";

/**
 * One bounded pass over the AI backlog.
 *
 * Every Worker invocation has its own budget (50 D1 queries on the free
 * plan), so the backlog is drained by many small invocations rather than one
 * long one: the settings page calls this back to back, a save calls it once,
 * and the cron calls it as the fallback. A pass handles one kind of work and
 * costs a fixed number of queries however many saves it carries.
 */

/** Forty saves are eight packed Clef requests. */
export const TAG_DRAIN_LIMIT = 40;
export const EMBED_DRAIN_LIMIT = 12;
/** Chunks one pass will embed; saves beyond it go back to the queue. */
const EMBED_CHUNK_LIMIT = 96;
const EMBED_TEXTS_PER_CALL = 32;
const VECTORS_PER_UPSERT = 200;

type Settings = Awaited<ReturnType<typeof getAiSettings>>;
type Entry = { job: ClaimedAiJob; item: AiSourceItem };

export interface AiDrainResult {
	kind: AiJobKind | null;
	/** Saves finished by this pass. */
	processed: number;
	/** Saves this pass picked up, finished or not. */
	claimed: number;
	/** Why saves in this pass were not finished, when a provider refused. */
	error?: string;
}

export interface AiDrainEnv {
	ai?: AiBinding;
	vectorize?: VectorizeBinding;
}

const jobId = (kind: AiJobKind, model: string, itemId: string, hash: string) => `${kind}:${model}:${itemId}:${hash}`;

/**
 * Take a batch of work for this caller alone: jobs already queued and due,
 * then saves that were never queued. Both steps are single statements, so two
 * tabs draining at once never hold the same save.
 */
async function claimBatch(db: AnansiDb, kind: AiJobKind, model: string, limit: number, token: string, textFor: (item: AiSourceItem) => string): Promise<Entry[]> {
	const entries: Entry[] = [];
	const due = await claimDueAiJobs(db, kind, model, limit, token);
	if (due.length > 0) {
		const byId = new Map((await loadAiSourceItems(db, due.map((job) => job.itemId))).map((item) => [item.id, item]));
		const stale: string[] = [];
		for (const job of due) {
			const item = byId.get(job.itemId);
			// The save changed (or went) after it was queued. Dropping the job
			// lets the save be picked up below under its current content.
			if (!item || (await contentHash(textFor(item))) !== job.contentHash) stale.push(job.id);
			else entries.push({ job, item });
		}
		await deleteClaimedAiJobs(db, stale, token);
	}
	if (entries.length < limit) {
		const fresh = await unqueuedAiItems(db, kind, model, limit - entries.length);
		if (fresh.length > 0) {
			const rows = await Promise.all(fresh.map(async (item) => {
				const hash = await contentHash(textFor(item));
				return { id: jobId(kind, model, item.id, hash), itemId: item.id, contentHash: hash, item };
			}));
			const mine = await insertClaimedAiJobs(db, kind, rows.map(({ id, itemId, contentHash: hash }) => ({ id, itemId, contentHash: hash })), token);
			for (const row of rows) {
				if (mine.has(row.id)) entries.push({ job: { id: row.id, itemId: row.itemId, contentHash: row.contentHash, attempts: 1 }, item: row.item });
			}
		}
	}
	return entries;
}

async function failByCode(db: AnansiDb, failures: readonly { job: ClaimedAiJob; code: AiJobFailureCode }[], token: string): Promise<void> {
	const codes = new Set(failures.map(({ code }) => code));
	for (const code of codes) {
		await failClaimedAiJobs(db, failures.filter((failure) => failure.code === code).map(({ job }) => job), token, code);
	}
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function drainTagging(db: AnansiDb, ai: AiBinding, settings: Settings, limit: number): Promise<AiDrainResult> {
	const token = crypto.randomUUID();
	const model = settings.tagModel;
	const entries = await claimBatch(db, "tagging", model, limit, token, searchableText);
	if (entries.length === 0) return { kind: "tagging", processed: 0, claimed: 0 };
	const answers = await generateTagsBatch(ai, model, entries.map(({ item }) => searchableText(item)), 3);
	const tagged: { entry: Entry; topics: string[] }[] = [];
	const failures: { job: ClaimedAiJob; code: AiJobFailureCode }[] = [];
	let error: string | undefined;
	entries.forEach((entry, index) => {
		const answer = answers[index];
		if (Array.isArray(answer)) tagged.push({ entry, topics: answer });
		else {
			failures.push({ job: entry.job, code: classifyAiJobFailure(answer) });
			error ??= describe(answer ?? "no answer");
		}
	});
	await publishAiTags(db, tagged.map(({ entry, topics }) => ({
		jobId: entry.job.id,
		itemId: entry.item.id,
		topics: topics.flatMap((id) => { const topic = topicDefinition(id); return topic ? [topic] : []; }),
	})), model, token);
	const processed = await completeClaimedAiJobs(db, tagged.map(({ entry }) => entry.job.id), token);
	await failByCode(db, failures, token);
	return { kind: "tagging", processed, claimed: entries.length, error };
}

async function drainEmbedding(db: AnansiDb, ai: AiBinding, vectorize: VectorizeBinding, settings: Settings, limit: number): Promise<AiDrainResult> {
	const token = crypto.randomUUID();
	const model = settings.embeddingModel;
	const generation = settings.semanticGeneration;
	const claimed = await claimBatch(db, "embedding", model, limit, token, (item) => embeddingProjectionText(item, generation));
	if (claimed.length === 0) return { kind: "embedding", processed: 0, claimed: 0 };

	// Plan chunks in memory, and keep only as many saves as one pass can embed.
	const entries: Entry[] = [];
	const overflow: string[] = [];
	const drafts: SemanticChunkDraft[] = [];
	for (const entry of claimed) {
		const plan = await planSemanticChunks(entry.item, model, generation);
		if (entries.length > 0 && drafts.length + plan.drafts.length > EMBED_CHUNK_LIMIT) { overflow.push(entry.job.id); continue; }
		entries.push(entry);
		drafts.push(...plan.drafts.map((draft) => ({ ...draft, generation })));
	}
	await releaseClaimedAiJobs(db, overflow, token);
	const jobs = entries.map(({ job }) => job);
	const fail = async (cause: unknown): Promise<AiDrainResult> => {
		const code = classifyAiJobFailure(cause);
		await failClaimedAiJobs(db, jobs, token, code);
		return { kind: "embedding", processed: 0, claimed: entries.length, error: describe(cause) };
	};

	const indexed = await stageSemanticChunksBulk(db, drafts);
	const pending = drafts.filter((draft) => !indexed.has(draft.id));
	const vectors: { id: string; values: number[] }[] = [];
	if (pending.length > 0) {
		const budget = await consumeSemanticCredits(db, pending.map((draft) => draft.chunkText));
		if (!budget.allowed) return fail(new AiProviderError("quota", "The monthly credit cap is reached. Raise the cap to keep indexing"));
		try {
			const groups: SemanticChunkDraft[][] = [];
			for (let offset = 0; offset < pending.length; offset += EMBED_TEXTS_PER_CALL) groups.push(pending.slice(offset, offset + EMBED_TEXTS_PER_CALL));
			const embedded = await Promise.all(groups.map((group) => embedBatch(ai, model, group.map((draft) => draft.chunkText), settings.embeddingDimensions)));
			groups.forEach((group, groupIndex) => group.forEach((draft, index) => vectors.push({ id: draft.id, values: embedded[groupIndex]![index]! })));
		} catch (cause) {
			return fail(cause);
		}
	}

	// The switch, the model or the index generation may have changed while the
	// provider was working. Vectors for a retired generation are never published.
	const current = await getAiSettings(db);
	if (current.semanticSearchEnabled !== 1 || current.semanticIndexPaused === 1 || current.semanticGeneration !== generation || current.embeddingModel !== model) {
		await discardSemanticChunks(db, drafts.map((draft) => draft.id));
		await releaseClaimedAiJobs(db, jobs.map((job) => job.id), token);
		return { kind: "embedding", processed: 0, claimed: entries.length };
	}

	const index = createVectorIndex(vectorize, settings.embeddingDimensions);
	try {
		for (let offset = 0; offset < vectors.length; offset += VECTORS_PER_UPSERT) await index.upsert(vectors.slice(offset, offset + VECTORS_PER_UPSERT));
	} catch (cause) {
		return fail(cause);
	}
	await markSemanticChunksCompleteBulk(db, vectors.map((vector) => vector.id), settings.embeddingDimensions);

	// Chunks from an older version of a save are rare; only then pay for cleanup.
	const active = drafts.map((draft) => draft.id);
	for (const itemId of await itemsWithStaleSemanticRows(db, entries.map(({ item }) => item.id), active)) {
		const staleIds = await retireStaleSemanticChunks(db, itemId, drafts.filter((draft) => draft.itemId === itemId).map((draft) => draft.id));
		if (staleIds.length === 0 || !index.deleteByIds) continue;
		try {
			await index.deleteByIds(staleIds);
			await completeSemanticVectorDeletions(db, staleIds);
		} catch { /* durable tombstones retry on the schedule */ }
	}
	const processed = await completeClaimedAiJobs(db, jobs.map((job) => job.id), token);
	return { kind: "embedding", processed, claimed: entries.length };
}

/**
 * Run one pass: tagging first, and indexing once no tagging work is left to
 * pick up. One kind per pass keeps the query count of an invocation fixed.
 */
export async function drainAi(
	db: AnansiDb,
	env: AiDrainEnv,
	options: { settings?: Settings; tagLimit?: number; embedLimit?: number } = {},
): Promise<AiDrainResult> {
	const ai = env.ai;
	if (!ai) return { kind: null, processed: 0, claimed: 0 };
	const settings = options.settings ?? await getAiSettings(db);
	if (settings.autoTaggingEnabled === 1) {
		const tagging = await drainTagging(db, ai, settings, options.tagLimit ?? TAG_DRAIN_LIMIT);
		if (tagging.claimed > 0) return tagging;
	}
	if (env.vectorize && settings.semanticSearchEnabled === 1 && settings.semanticIndexPaused !== 1) {
		return drainEmbedding(db, ai, env.vectorize, settings, options.embedLimit ?? EMBED_DRAIN_LIMIT);
	}
	return { kind: null, processed: 0, claimed: 0 };
}
