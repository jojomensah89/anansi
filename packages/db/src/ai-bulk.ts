import { sql } from "drizzle-orm";
import type { AiJobFailureCode, AiJobKind, getAiSettings } from "./ai-jobs.ts";
import { mutationChanges } from "./ai-jobs.ts";
import type { AnansiDb } from "./types.ts";

/**
 * Set-based AI job statements.
 *
 * Workers Free allows 50 D1 queries per invocation and 100 bound parameters
 * per statement. Every statement here takes its rows as one JSON parameter
 * read through json_each, so a whole batch of saves costs one query and one
 * parameter however many rows it carries.
 */

const LEASE_SECONDS = 120;

export interface ClaimedAiJob {
	id: string;
	itemId: string;
	contentHash: string;
	attempts: number;
}

/** Only the columns either AI projection reads; never the raw payload. */
export interface AiSourceItem {
	id: string;
	title: string | null;
	body: string | null;
	articleText: string | null;
	authorName: string | null;
	authorHandle: string | null;
}

type SourceRow = { id: string; title: string | null; body: string | null; article_text: string | null; author_name: string | null; author_handle: string | null };
type JobRow = { id: string; item_id: string; content_hash: string; attempts: number };

const sourceItem = (row: SourceRow): AiSourceItem => ({ id: row.id, title: row.title, body: row.body, articleText: row.article_text, authorName: row.author_name, authorHandle: row.author_handle });
const claimedJob = (row: JobRow): ClaimedAiJob => ({ id: row.id, itemId: row.item_id, contentHash: row.content_hash, attempts: Number(row.attempts) });
const jobPrefix = (kind: AiJobKind, model: string) => `${kind}:${model}:`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Claim due jobs in one statement. SQLite runs the UPDATE atomically, so two
 * callers can never both receive the same row.
 */
export async function claimDueAiJobs(db: AnansiDb, kind: AiJobKind, model: string, limit: number, token: string, now = nowSeconds()): Promise<ClaimedAiJob[]> {
	const prefix = jobPrefix(kind, model);
	const rows = await db.all<JobRow>(sql`
		UPDATE ai_enrichment_jobs
		SET status = 'running', claim_token = ${token}, lease_until = ${now + LEASE_SECONDS}, attempts = attempts + 1, updated_at = ${now}
		WHERE id IN (
			SELECT id FROM ai_enrichment_jobs
			WHERE kind = ${kind} AND substr(id, 1, ${prefix.length}) = ${prefix}
				AND status IN ('pending', 'retrying', 'running') AND next_run_at <= ${now} AND lease_until <= ${now}
			ORDER BY next_run_at, id LIMIT ${limit}
		)
		RETURNING id, item_id, content_hash, attempts`);
	return rows.map(claimedJob);
}

/** Saves with no job at all for this model, most recently stored first. */
export async function unqueuedAiItems(db: AnansiDb, kind: AiJobKind, model: string, limit: number): Promise<AiSourceItem[]> {
	const prefix = jobPrefix(kind, model);
	const rows = await db.all<SourceRow>(sql`
		SELECT i.id, i.title, i.body, i.article_text, i.author_name, i.author_handle FROM items i
		WHERE NOT EXISTS (
			SELECT 1 FROM ai_enrichment_jobs j
			WHERE j.item_id = i.id AND j.kind = ${kind} AND substr(j.id, 1, ${prefix.length}) = ${prefix}
		)
		ORDER BY i.rowid DESC LIMIT ${limit}`);
	return rows.map(sourceItem);
}

/**
 * Create jobs already claimed by this caller. A row another caller created
 * first conflicts and is not returned, so it is not processed twice.
 */
export async function insertClaimedAiJobs(db: AnansiDb, kind: AiJobKind, rows: readonly { id: string; itemId: string; contentHash: string }[], token: string, now = nowSeconds()): Promise<Set<string>> {
	if (rows.length === 0) return new Set();
	const inserted = await db.all<{ id: string }>(sql`
		INSERT INTO ai_enrichment_jobs (id, item_id, kind, content_hash, status, attempts, next_run_at, lease_until, claim_token, created_at, updated_at)
		SELECT json_extract(value, '$.id'), json_extract(value, '$.itemId'), ${kind}, json_extract(value, '$.contentHash'), 'running', 1, 0, ${now + LEASE_SECONDS}, ${token}, ${now}, ${now}
		FROM json_each(${JSON.stringify(rows)})
		WHERE EXISTS (SELECT 1 FROM items WHERE items.id = json_extract(value, '$.itemId'))
		ON CONFLICT(id) DO NOTHING
		RETURNING id`);
	return new Set(inserted.map((row) => row.id));
}

export async function loadAiSourceItems(db: AnansiDb, ids: readonly string[]): Promise<AiSourceItem[]> {
	if (ids.length === 0) return [];
	const rows = await db.all<SourceRow>(sql`
		SELECT id, title, body, article_text, author_name, author_handle FROM items
		WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
	return rows.map(sourceItem);
}

/** Complete every listed job this caller still holds; returns how many. */
export async function completeClaimedAiJobs(db: AnansiDb, ids: readonly string[], token: string, now = nowSeconds()): Promise<number> {
	if (ids.length === 0) return 0;
	const result = await db.run(sql`
		UPDATE ai_enrichment_jobs SET status = 'complete', claim_token = NULL, lease_until = 0, last_error = NULL, updated_at = ${now}
		WHERE claim_token = ${token} AND status = 'running' AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
	return mutationChanges(result);
}

/** Hand claims back untouched, without spending an attempt. */
export async function releaseClaimedAiJobs(db: AnansiDb, ids: readonly string[], token: string, now = nowSeconds()): Promise<void> {
	if (ids.length === 0) return;
	await db.run(sql`
		UPDATE ai_enrichment_jobs SET status = 'pending', attempts = max(attempts - 1, 0), claim_token = NULL, lease_until = 0, next_run_at = 0, last_error = NULL, updated_at = ${now}
		WHERE claim_token = ${token} AND status = 'running' AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
}

/** Drop jobs whose save changed since they were queued, so the save is queued afresh. */
export async function deleteClaimedAiJobs(db: AnansiDb, ids: readonly string[], token: string): Promise<void> {
	if (ids.length === 0) return;
	await db.run(sql`
		DELETE FROM ai_enrichment_jobs
		WHERE claim_token = ${token} AND status = 'running' AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
}

/** Same backoff and terminal rules as failAiJob, for a whole batch. */
export async function failClaimedAiJobs(db: AnansiDb, jobs: readonly Pick<ClaimedAiJob, "id" | "attempts">[], token: string, code: AiJobFailureCode, now = nowSeconds()): Promise<void> {
	if (jobs.length === 0) return;
	const rows = JSON.stringify(jobs.map((job) => {
		const terminal = code === "malformed" || code === "dimension" || (code === "unknown" && job.attempts >= 5);
		const delay = Math.min(86_400, 60 * 2 ** Math.min(Math.max(job.attempts - 1, 0), 11));
		return { id: job.id, status: terminal ? "failed" : "retrying", nextRunAt: now + delay };
	}));
	await db.run(sql`
		UPDATE ai_enrichment_jobs SET
			status = (SELECT json_extract(value, '$.status') FROM json_each(${rows}) WHERE json_extract(value, '$.id') = ai_enrichment_jobs.id),
			next_run_at = (SELECT json_extract(value, '$.nextRunAt') FROM json_each(${rows}) WHERE json_extract(value, '$.id') = ai_enrichment_jobs.id),
			claim_token = NULL, lease_until = 0, last_error = ${`ai:${code}`}, updated_at = ${now}
		WHERE claim_token = ${token} AND status = 'running'
			AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${rows}))`);
}

export interface AiTagResult {
	jobId: string;
	itemId: string;
	topics: readonly { id: string; label: string; color: string }[];
}

/**
 * Replace the AI topics of every save in a batch. Each statement only touches
 * saves whose job this caller still holds, so a claim lost to an expired
 * lease cannot write. Manual tags and suppressed topics are left alone.
 */
export async function publishAiTags(db: AnansiDb, results: readonly AiTagResult[], model: string, token: string, now = nowSeconds()): Promise<void> {
	if (results.length === 0) return;
	const jobIds = JSON.stringify(results.map((result) => result.jobId));
	const topics = new Map(results.flatMap((result) => result.topics.map((topic) => [topic.id, topic] as const)));
	const pairs = results.flatMap((result) => result.topics.map((topic) => ({ jobId: result.jobId, itemId: result.itemId, tagId: `topic:${topic.id}` })));
	if (topics.size > 0) {
		// OR IGNORE covers a custom tag that already owns the label; the upsert
		// promotes an existing row with this id to a topic.
		await db.run(sql`
			INSERT OR IGNORE INTO tags (id, label, color, origin, kind)
			SELECT json_extract(value, '$.id'), json_extract(value, '$.label'), json_extract(value, '$.color'), 'ai', 'topic'
			FROM json_each(${JSON.stringify([...topics.values()].map((topic) => ({ id: `topic:${topic.id}`, label: topic.label, color: topic.color })))})
			WHERE true
			ON CONFLICT(id) DO UPDATE SET kind = 'topic', color = excluded.color WHERE tags.kind != 'topic'`);
	}
	await db.run(sql`
		DELETE FROM item_tags WHERE provenance = 'ai' AND item_id IN (
			SELECT item_id FROM ai_enrichment_jobs
			WHERE claim_token = ${token} AND status = 'running' AND id IN (SELECT value FROM json_each(${jobIds}))
		)`);
	if (pairs.length === 0) return;
	await db.run(sql`
		INSERT OR IGNORE INTO item_tags (item_id, tag_id, provenance, model, applied_at)
		SELECT pair.item_id, pair.tag_id, 'ai', ${model}, ${now}
		FROM (
			SELECT json_extract(value, '$.itemId') AS item_id, json_extract(value, '$.tagId') AS tag_id, json_extract(value, '$.jobId') AS job_id
			FROM json_each(${JSON.stringify(pairs)})
		) AS pair
		WHERE EXISTS (SELECT 1 FROM tags WHERE tags.id = pair.tag_id)
			AND EXISTS (SELECT 1 FROM ai_enrichment_jobs j WHERE j.id = pair.job_id AND j.claim_token = ${token} AND j.status = 'running')
			AND NOT EXISTS (SELECT 1 FROM item_tag_overrides o WHERE o.item_id = pair.item_id AND o.tag_id = pair.tag_id AND o.override = 'suppressed')`);
}

export interface SemanticChunkDraft {
	id: string;
	itemId: string;
	chunkIndex: number;
	chunkText: string;
	contentHash: string;
	parentHash: string;
	startOffset: number;
	endOffset: number;
	chunkerVersion: string;
	model: string;
	generation?: number;
}

/** Stage every chunk of a batch in one statement; returns the ids already indexed. */
export async function stageSemanticChunksBulk(db: AnansiDb, drafts: readonly SemanticChunkDraft[], now = nowSeconds()): Promise<Set<string>> {
	if (drafts.length === 0) return new Set();
	const rows = await db.all<{ id: string; status: string }>(sql`
		INSERT INTO semantic_chunks (id, item_id, chunk_index, chunk_text, content_hash, parent_hash, start_offset, end_offset, chunker_version, model, generation, dimensions, status, created_at, updated_at)
		SELECT json_extract(value, '$.id'), json_extract(value, '$.itemId'), json_extract(value, '$.chunkIndex'), json_extract(value, '$.chunkText'),
			json_extract(value, '$.contentHash'), json_extract(value, '$.parentHash'), json_extract(value, '$.startOffset'), json_extract(value, '$.endOffset'),
			json_extract(value, '$.chunkerVersion'), json_extract(value, '$.model'), coalesce(json_extract(value, '$.generation'), 1), 0, 'pending', ${now}, ${now}
		FROM json_each(${JSON.stringify(drafts)})
		WHERE true
		ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, chunk_text = excluded.chunk_text, parent_hash = excluded.parent_hash,
			generation = excluded.generation, start_offset = excluded.start_offset, end_offset = excluded.end_offset, updated_at = excluded.updated_at
		RETURNING id, status`);
	return new Set(rows.filter((row) => row.status === "complete").map((row) => row.id));
}

export async function markSemanticChunksCompleteBulk(db: AnansiDb, ids: readonly string[], dimensions: number, now = nowSeconds()): Promise<void> {
	if (ids.length === 0) return;
	await db.run(sql`
		UPDATE semantic_chunks SET status = 'complete', dimensions = ${dimensions}, updated_at = ${now}
		WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
}

/** Saves in the batch that still hold chunks or legacy vectors outside the active set. */
export async function itemsWithStaleSemanticRows(db: AnansiDb, itemIds: readonly string[], activeChunkIds: readonly string[]): Promise<string[]> {
	if (itemIds.length === 0) return [];
	const items = JSON.stringify(itemIds);
	const rows = await db.all<{ item_id: string }>(sql`
		SELECT item_id FROM semantic_chunks
		WHERE item_id IN (SELECT value FROM json_each(${items})) AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(activeChunkIds)}))
		UNION
		SELECT item_id FROM item_embeddings WHERE item_id IN (SELECT value FROM json_each(${items}))`);
	return rows.map((row) => row.item_id);
}

type Progress = { pending: number; failed: number; complete: number };

/** Every progress figure the settings page shows, in two queries. */
export async function aiProgressAll(db: AnansiDb, settings: Pick<Awaited<ReturnType<typeof getAiSettings>>, "embeddingModel" | "tagModel">): Promise<{ progress: Progress; embeddingProgress: Progress; taggingProgress: Progress }> {
	const embedding = jobPrefix("embedding", settings.embeddingModel);
	const tagging = jobPrefix("tagging", settings.tagModel);
	const rows = await db.all<{ kind: string; failed: number | null; complete: number | null }>(sql`
		SELECT kind, sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, sum(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete
		FROM ai_enrichment_jobs
		WHERE (kind = 'embedding' AND substr(id, 1, ${embedding.length}) = ${embedding}) OR (kind = 'tagging' AND substr(id, 1, ${tagging.length}) = ${tagging})
		GROUP BY kind`);
	const [library] = await db.all<{ total: number }>(sql`SELECT count(*) AS total FROM items`);
	const total = Number(library?.total ?? 0);
	const figures = (kinds: readonly string[]): Progress => {
		const picked = rows.filter((row) => kinds.includes(row.kind));
		const complete = Math.min(total, picked.reduce((sum, row) => sum + Number(row.complete ?? 0), 0));
		const failed = picked.reduce((sum, row) => sum + Number(row.failed ?? 0), 0);
		return { pending: Math.max(0, total - complete - failed), failed, complete };
	};
	return { progress: figures(["embedding", "tagging"]), embeddingProgress: figures(["embedding"]), taggingProgress: figures(["tagging"]) };
}
