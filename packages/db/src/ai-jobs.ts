import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { aiEnrichmentJobs, aiSettings, itemEmbeddings, itemTagOverrides, itemTags, items, tags } from "./schema.ts";
import type { AnansiDb } from "./types.ts";
import { canonicalizeTopicIds, topicDefinition } from "./topics.ts";

export type AiJobKind = "embedding" | "tagging";
export type AiJob = typeof aiEnrichmentJobs.$inferSelect & { token: string };
export type AiJobFailureCode = "quota" | "unavailable" | "malformed" | "dimension" | "unknown";
export const AI_JOB_RECONCILIATION_CHUNK_SIZE = 16;

/**
 * Drizzle's SQLite drivers expose changed rows at the root while D1 exposes
 * them under `meta`. Keep transition and reconciliation counts portable.
 */
export function mutationChanges(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const record = result as {
		changes?: unknown;
		meta?: { changes?: unknown } | null;
	};
	const value = record.changes ?? record.meta?.changes;
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

/** Splits reconciliation rows without overlap and within D1's bind budget. */
export function chunkAiJobRows<T>(rows: readonly T[], size = AI_JOB_RECONCILIATION_CHUNK_SIZE): T[][] {
	if (!Number.isInteger(size) || size < 1) throw new Error("AI job chunk size must be positive");
	const chunks: T[][] = [];
	for (let offset = 0; offset < rows.length; offset += size) {
		chunks.push(rows.slice(offset, offset + size));
	}
	return chunks;
}

export function searchableText(item: Pick<typeof items.$inferSelect, "title" | "body" | "articleText" | "authorName" | "authorHandle">): string {
  return [item.title, item.body, item.articleText, item.authorName, item.authorHandle]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

/** Stable, bounded projection used for semantic vectors. */
export function semanticText(item: Pick<typeof items.$inferSelect, "title" | "body" | "articleText" | "authorName" | "authorHandle" | "source" | "url">): string {
  return [item.title, item.body, item.articleText, item.authorName, item.authorHandle, item.source, item.url]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

export async function contentHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export async function getAiSettings(db: AnansiDb) {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.id, 1));
  return row ?? { id: 1, semanticSearchEnabled: 0, autoTaggingEnabled: 0, embeddingModel: "@cf/baai/bge-small-en-v1.5", embeddingDimensions: 384, tagModel: "@cf/meta/llama-3.1-8b-instruct", updatedAt: 0, quotaPauseReason: null, lastRunAt: null };
}

export async function setAiSettings(db: AnansiDb, patch: { semanticSearchEnabled?: boolean; autoTaggingEnabled?: boolean }) {
  const now = Math.floor(Date.now() / 1000);
  await db.insert(aiSettings).values({ id: 1, semanticSearchEnabled: patch.semanticSearchEnabled ? 1 : 0, autoTaggingEnabled: patch.autoTaggingEnabled ? 1 : 0, updatedAt: now })
    .onConflictDoUpdate({ target: aiSettings.id, set: { ...(patch.semanticSearchEnabled === undefined ? {} : { semanticSearchEnabled: patch.semanticSearchEnabled ? 1 : 0 }), ...(patch.autoTaggingEnabled === undefined ? {} : { autoTaggingEnabled: patch.autoTaggingEnabled ? 1 : 0 }), updatedAt: now } });
  return getAiSettings(db);
}

function legacyTaggingJobId(itemId: string, hash: string): string {
	return `tagging:${itemId}:${hash}`;
}

const LEGACY_TAGGING_CLEANUP_LIMIT = 20;

/**
 * The first tagging job identity omitted the model. Retire those rows during
 * normal reconciliation. If their current AI projection was produced by the
 * active model for the current content, carry that completion forward so an
 * upgrade does not trigger a full retag.
 */
async function retireLegacyTaggingJobs(
	db: AnansiDb,
	settings: Awaited<ReturnType<typeof getAiSettings>>,
	jobs: (typeof aiEnrichmentJobs.$inferSelect)[],
	existing: Set<string>,
	now: number,
): Promise<void> {
	// Keep this migration bounded. A legacy queue can be much larger than the
	// normal reconciliation budget, and one write per row would exhaust D1's
	// per-invocation query budget before current work gets a chance to queue.
	const legacyJobs = jobs
		.filter(
			(job) => job.kind === "tagging" && job.id === legacyTaggingJobId(job.itemId, job.contentHash),
		)
		.slice(0, LEGACY_TAGGING_CLEANUP_LIMIT);
	if (legacyJobs.length === 0) return;

	const itemIds = [...new Set(legacyJobs.map((job) => job.itemId))];
	const activeProjectionItems = new Set(
		(
			await db
				.select({ itemId: itemTags.itemId })
				.from(itemTags)
				.where(
					and(
						eq(itemTags.provenance, "ai"),
						eq(itemTags.model, settings.tagModel),
						inArray(itemTags.itemId, itemIds),
					),
				)
		).map((row) => row.itemId),
	);
	const currentItems = await db.select().from(items).where(inArray(items.id, itemIds));
	const itemsById = new Map(currentItems.map((item) => [item.id, item]));

	const carryForward: (typeof aiEnrichmentJobs.$inferInsert)[] = [];
	const retiredIds: string[] = [];
	for (const job of legacyJobs) {
		const item = itemsById.get(job.itemId);
		const currentHash = item ? await contentHash(searchableText(item)) : undefined;
		const projectionIsCurrent =
			activeProjectionItems.has(job.itemId) && currentHash === job.contentHash;
		if (projectionIsCurrent) {
			const qualifiedId = `tagging:${settings.tagModel}:${job.itemId}:${job.contentHash}`;
			if (!existing.has(qualifiedId)) {
				carryForward.push({
					id: qualifiedId,
					itemId: job.itemId,
					kind: "tagging",
					contentHash: job.contentHash,
					status: "complete",
					attempts: job.attempts,
					nextRunAt: 0,
					leaseUntil: 0,
					claimToken: null,
					lastError: null,
					createdAt: job.createdAt,
					updatedAt: now,
				});
				existing.add(qualifiedId);
			}
		}
		retiredIds.push(job.id);
	}

	// Use a few bounded inserts and one delete. The qualified rows are written
	// before the legacy rows are removed so a restart cannot force a retag.
	// Eight rows keep the twelve explicitly supplied columns below D1's bound
	// parameter ceiling while still avoiding one remote write per legacy row.
	for (let offset = 0; offset < carryForward.length; offset += 8) {
		await db
			.insert(aiEnrichmentJobs)
			.values(carryForward.slice(offset, offset + 8))
			.onConflictDoNothing()
			.run();
	}
	if (retiredIds.length > 0) {
		await db.delete(aiEnrichmentJobs).where(inArray(aiEnrichmentJobs.id, retiredIds)).run();
		for (const id of retiredIds) existing.delete(id);
	}
}

/** Reconciles changed items without calling a remote provider. */
export async function reconcileAiJobs(db: AnansiDb, limit = 100, model?: string, onlyKinds?: AiJobKind[]): Promise<number> {
	const settings = await getAiSettings(db);
	const now = Math.floor(Date.now() / 1000);
	const jobs = await db.select().from(aiEnrichmentJobs);
	const existing = new Set(jobs.map((job) => job.id));
	await retireLegacyTaggingJobs(db, settings, jobs, existing, now);
	if (!settings.semanticSearchEnabled && !settings.autoTaggingEnabled) return 0;
	const wantedKinds = new Set(onlyKinds ?? ["embedding", "tagging"]);
	// Scan the complete library when reconciling. The insertion cap below keeps
	// each pass bounded, but limiting this read to the first 500 rows strands
	// newer items forever once those rows already have jobs.
	const rows = await db.select().from(items).orderBy(items.savedAt);
	const insertLimit = Math.min(Math.max(limit, 1), 100);
	const pendingRows: (typeof aiEnrichmentJobs.$inferInsert)[] = [];
	for (const item of rows) {
		const kinds: AiJobKind[] = [];
		if (settings.semanticSearchEnabled && wantedKinds.has("embedding")) kinds.push("embedding");
		if (settings.autoTaggingEnabled && wantedKinds.has("tagging")) kinds.push("tagging");
		for (const kind of kinds) {
			const hash = await contentHash(kind === "embedding" ? semanticText(item) : searchableText(item));
			// Both projections are model generations. Include the active model in
			// the durable identity so changing either provider queues current work
			// instead of reusing a terminal job from the previous model.
			const activeModel = model ?? (kind === "embedding" ? settings.embeddingModel : settings.tagModel);
			const id = `${kind}:${activeModel}:${item.id}:${hash}`;
			if (existing.has(id) || pendingRows.length >= insertLimit) continue;
			pendingRows.push({ id, itemId: item.id, kind, contentHash: hash, createdAt: now, updatedAt: now });
			existing.add(id);
		}
	}
	let inserted = 0;
	// Keep bind counts and statement sizes conservative for both Bun SQLite and
	// D1 while reducing one remote write per job to a small number of writes.
	// Six explicitly supplied columns per row keep sixteen-row statements below
	// D1's bound-parameter ceiling.
	for (const chunk of chunkAiJobRows(pendingRows)) {
		const result = await db
			.insert(aiEnrichmentJobs)
			.values(chunk)
			.onConflictDoNothing()
			.run();
		inserted += mutationChanges(result);
	}
	return inserted;
}

export async function claimAiJobs(db: AnansiDb, kind: AiJobKind, limit = 4, now = Math.floor(Date.now() / 1000), model?: string): Promise<AiJob[]> {
  const settings = await getAiSettings(db);
  if ((kind === "embedding" && !settings.semanticSearchEnabled) || (kind === "tagging" && !settings.autoTaggingEnabled)) return [];
  // An expired running lease belongs to a worker that stopped before it could
  // complete the job. Reclaim it alongside pending/retrying work so a local
  // server restart cannot strand an AI projection forever.
  const modelPrefix = model ? `${kind}:${model}:` : undefined;
  // Use an exact, case-sensitive prefix expression rather than LIKE. Model
  // names may contain '%' or '_' and must not broaden the claimed set.
  const modelFilter = modelPrefix
    ? sql`substr(${aiEnrichmentJobs.id}, 1, ${modelPrefix.length}) = ${modelPrefix}`
    : undefined;
  const rows = await db.select().from(aiEnrichmentJobs).where(and(eq(aiEnrichmentJobs.kind, kind), modelFilter, inArray(aiEnrichmentJobs.status, ["pending", "retrying", "running"]), lte(aiEnrichmentJobs.nextRunAt, now), lte(aiEnrichmentJobs.leaseUntil, now))).orderBy(aiEnrichmentJobs.nextRunAt, aiEnrichmentJobs.id).limit(Math.min(Math.max(limit, 1), 20));
  const claimed: AiJob[] = [];
  for (const row of rows) {
    const token = crypto.randomUUID();
    // The candidate query is only a snapshot. Re-state every selected fact in
    // the write predicate so a row completed after selection cannot be revived
    // by a stale claimant. A running row may be reclaimed only after its lease
    // has actually expired.
    const selectedStatus = row.status === "running"
      ? and(eq(aiEnrichmentJobs.status, "running"), lte(aiEnrichmentJobs.leaseUntil, now))
      : inArray(aiEnrichmentJobs.status, ["pending", "retrying"]);
    const selectedToken = row.claimToken === null
      ? isNull(aiEnrichmentJobs.claimToken)
      : eq(aiEnrichmentJobs.claimToken, row.claimToken);
    const won = await db.update(aiEnrichmentJobs)
      .set({ status: "running", claimToken: token, leaseUntil: now + 120, attempts: sql`${aiEnrichmentJobs.attempts} + 1`, updatedAt: now })
      .where(and(
        eq(aiEnrichmentJobs.id, row.id),
        selectedStatus,
        selectedToken,
        eq(aiEnrichmentJobs.nextRunAt, row.nextRunAt),
        eq(aiEnrichmentJobs.leaseUntil, row.leaseUntil),
        eq(aiEnrichmentJobs.attempts, row.attempts),
        eq(aiEnrichmentJobs.updatedAt, row.updatedAt),
      ))
      .returning();
    if (won[0]) claimed.push({ ...won[0], token });
  }
  return claimed;
}

/** Loads only the canonical items referenced by an already-claimed batch. */
export async function loadAiJobItems(db: AnansiDb, itemIds: string[]) {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids));
}

/** Persists the canonical metadata for a successfully written embedding. */
export async function upsertItemEmbedding(
  db: AnansiDb,
  input: { itemId: string; vectorId?: string; model: string; dimensions: number; contentHash: string; now?: number },
) {
  const timestamp = input.now ?? Math.floor(Date.now() / 1000);
  await db
    .insert(itemEmbeddings)
    .values({
      itemId: input.itemId,
      vectorId: input.vectorId ?? input.itemId,
      model: input.model,
      dimensions: input.dimensions,
      contentHash: input.contentHash,
      status: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: itemEmbeddings.itemId,
      set: {
        vectorId: input.vectorId ?? input.itemId,
        model: input.model,
        dimensions: input.dimensions,
        contentHash: input.contentHash,
        status: "complete",
        updatedAt: timestamp,
        lastError: null,
      },
    });
}

export async function validateAiJobClaim(db: AnansiDb, id: string, token: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const [row] = await db.select({ id: aiEnrichmentJobs.id }).from(aiEnrichmentJobs).where(and(eq(aiEnrichmentJobs.id, id), eq(aiEnrichmentJobs.claimToken, token), eq(aiEnrichmentJobs.status, "running"), gt(aiEnrichmentJobs.leaseUntil, now))).limit(1);
  return Boolean(row);
}

export async function completeAiJob(db: AnansiDb, id: string, token: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const result = await db.update(aiEnrichmentJobs)
    .set({ status: "complete", claimToken: null, leaseUntil: 0, updatedAt: now, lastError: null })
    .where(and(
      eq(aiEnrichmentJobs.id, id),
      eq(aiEnrichmentJobs.status, "running"),
      eq(aiEnrichmentJobs.claimToken, token),
      gt(aiEnrichmentJobs.leaseUntil, now),
    ))
    .run();
  return mutationChanges(result) > 0;
}

/** Releases a settings-fenced claim without counting it as a provider attempt. */
export async function releaseAiJob(
	db: AnansiDb,
	id: string,
	token: string,
	attempts: number,
	now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const result = await db
		.update(aiEnrichmentJobs)
		.set({
			status: "pending",
			attempts: Math.max(attempts - 1, 0),
			claimToken: null,
			leaseUntil: 0,
			nextRunAt: 0,
			updatedAt: now,
			lastError: null,
		})
		.where(
			and(
				eq(aiEnrichmentJobs.id, id),
				eq(aiEnrichmentJobs.status, "running"),
				eq(aiEnrichmentJobs.claimToken, token),
				gt(aiEnrichmentJobs.leaseUntil, now),
			),
		)
		.run();
	return mutationChanges(result) > 0;
}

export async function failAiJob(db: AnansiDb, id: string, token: string, attempts: number, code: AiJobFailureCode, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const delay = Math.min(86_400, 60 * 2 ** Math.min(Math.max(attempts - 1, 0), 11));
  const terminal = code === "malformed" || code === "dimension" || (code === "unknown" && attempts >= 5);
  const result = await db.update(aiEnrichmentJobs)
    .set({ status: terminal ? "failed" : "retrying", claimToken: null, leaseUntil: 0, nextRunAt: now + delay, updatedAt: now, lastError: `ai:${code}` })
    .where(and(
      eq(aiEnrichmentJobs.id, id),
      eq(aiEnrichmentJobs.status, "running"),
      eq(aiEnrichmentJobs.claimToken, token),
      gt(aiEnrichmentJobs.leaseUntil, now),
    ))
    .run();
  return mutationChanges(result) > 0;
}

/**
 * Reopens terminal embedding jobs when the local sidecar no longer contains
 * their vectors. The canonical job row survives a sidecar rebuild, so without
 * this reset a fresh cache would look permanently complete and never warm.
 */
export async function requeueEmbeddingJobs(db: AnansiDb, itemIds: string[], embeddingModel?: string, includeFailed = false) {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const terminalStatuses = includeFailed ? ["complete", "failed"] : ["complete"];
  const candidates = await db.select({ id: aiEnrichmentJobs.id, itemId: aiEnrichmentJobs.itemId })
    .from(aiEnrichmentJobs)
    .where(and(eq(aiEnrichmentJobs.kind, "embedding"), inArray(aiEnrichmentJobs.status, terminalStatuses)));
  const targetIds = candidates
    .filter((job) => wanted.has(job.itemId) && (!embeddingModel || job.id.startsWith(`embedding:${embeddingModel}:`)))
    .map((job) => job.id);
  if (targetIds.length === 0) return 0;
  let changed = 0;
  for (let offset = 0; offset < targetIds.length; offset += 500) {
    const result = await db.update(aiEnrichmentJobs)
      .set({ status: "pending", attempts: 0, nextRunAt: 0, leaseUntil: 0, claimToken: null, lastError: null, updatedAt: Math.floor(Date.now() / 1000) })
      .where(inArray(aiEnrichmentJobs.id, targetIds.slice(offset, offset + 500)))
      .run();
    changed += mutationChanges(result);
  }
  return changed;
}

export async function aiProgress(db: AnansiDb, kind?: AiJobKind, model?: string) {
  const settings = await getAiSettings(db);
  const prefixes = kind
    ? [`${kind}:${model ?? (kind === "embedding" ? settings.embeddingModel : settings.tagModel)}:`]
    : [`embedding:${model ?? settings.embeddingModel}:`, `tagging:${model ?? settings.tagModel}:`];
  const modelFilter = sql`(${sql.join(prefixes.map((prefix) => sql`substr(${aiEnrichmentJobs.id}, 1, ${prefix.length}) = ${prefix}`), sql` OR `)})`;
  const [row] = await db.select({ pending: sql<number>`sum(case when status in ('pending','retrying','running') then 1 else 0 end)`, failed: sql<number>`sum(case when status='failed' then 1 else 0 end)`, complete: sql<number>`sum(case when status='complete' then 1 else 0 end)` }).from(aiEnrichmentJobs).where(and(kind ? eq(aiEnrichmentJobs.kind, kind) : undefined, modelFilter));
  return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0), complete: Number(row?.complete ?? 0) };
}

/** Clears AI topic assignments and reopens tagging jobs for a fresh taxonomy pass. */
export async function reclassifyAiTopics(db: AnansiDb): Promise<number> {
	const removed = await db.delete(itemTags).where(eq(itemTags.provenance, "ai")).run();
	await db.run(sql`DELETE FROM tags WHERE origin = 'ai' AND kind = 'custom' AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_tags.tag_id = tags.id)`);
	await db.update(aiEnrichmentJobs).set({ status: "pending", attempts: 0, nextRunAt: 0, leaseUntil: 0, claimToken: null, lastError: null, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(aiEnrichmentJobs.kind, "tagging"));
	return mutationChanges(removed);
}

/** Apply canonical AI topics without overriding manual intent or suppression. */
export async function applyAiTags(db: AnansiDb, itemId: string, labels: string[], model: string, now = Math.floor(Date.now() / 1000)) {
	const topicIds = canonicalizeTopicIds(labels, 3);
	await db.delete(itemTags).where(and(eq(itemTags.itemId, itemId), eq(itemTags.provenance, "ai")));
	for (const topicId of topicIds) {
		const topic = topicDefinition(topicId);
		if (!topic) continue;
		const tagId = `topic:${topic.id}`;
		const [existing] = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
		if (!existing) {
			await db.insert(tags).values({ id: tagId, label: topic.label, color: topic.color, origin: "ai", kind: "topic" }).onConflictDoNothing();
		} else if (existing.kind !== "topic") {
			await db.update(tags).set({ kind: "topic", color: topic.color }).where(eq(tags.id, tagId));
		}
		const [suppressed] = await db.select().from(itemTagOverrides).where(and(eq(itemTagOverrides.itemId, itemId), eq(itemTagOverrides.tagId, tagId), eq(itemTagOverrides.override, "suppressed"))).limit(1);
		if (suppressed) continue;
		await db.insert(itemTags).values({ itemId, tagId, provenance: "ai", model, appliedAt: now }).onConflictDoNothing();
	}
}

export { aiEnrichmentJobs, aiSettings, itemEmbeddings };
