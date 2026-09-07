import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { aiEnrichmentJobs, aiSettings, itemEmbeddings, itemTagOverrides, itemTags, items, tags } from "./schema.ts";
import type { AnansiDb } from "./types.ts";

export type AiJobKind = "embedding" | "tagging";
export type AiJob = typeof aiEnrichmentJobs.$inferSelect & { token: string };

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

/** Reconciles changed items without calling a remote provider. */
export async function reconcileAiJobs(db: AnansiDb, limit = 100, embeddingModel?: string, onlyKinds?: AiJobKind[]): Promise<number> {
  const settings = await getAiSettings(db);
  if (!settings.semanticSearchEnabled && !settings.autoTaggingEnabled) return 0;
  const wantedKinds = new Set(onlyKinds ?? ["embedding", "tagging"]);
  const rows = await db.select().from(items).orderBy(items.savedAt).limit(500);
  const existing = new Set((await db.select({ id: aiEnrichmentJobs.id }).from(aiEnrichmentJobs)).map((job) => job.id));
  let inserted = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const item of rows) {
    const kinds: AiJobKind[] = [];
    if (settings.semanticSearchEnabled && wantedKinds.has("embedding")) kinds.push("embedding");
    if (settings.autoTaggingEnabled && wantedKinds.has("tagging")) kinds.push("tagging");
    for (const kind of kinds) {
      const hash = await contentHash(kind === "embedding" ? semanticText(item) : searchableText(item));
      // Embedding vectors live in a model-specific vector space. Include the
      // active model in the durable job identity so switching models queues a
      // rebuild instead of incorrectly treating the previous model's job as
      // complete. The projection hash itself remains model-independent.
      const id = kind === "embedding"
        ? `${kind}:${embeddingModel ?? settings.embeddingModel}:${item.id}:${hash}`
        : `${kind}:${item.id}:${hash}`;
      if (existing.has(id) || inserted >= Math.min(Math.max(limit, 1), 100)) continue;
      const result = await db.insert(aiEnrichmentJobs).values({ id, itemId: item.id, kind, contentHash: hash, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
      existing.add(id);
      inserted += Number((result as { changes?: number }).changes ?? 0);
    }
  }
  return inserted;
}

export async function claimAiJobs(db: AnansiDb, kind: AiJobKind, limit = 4, now = Math.floor(Date.now() / 1000)): Promise<AiJob[]> {
  const settings = await getAiSettings(db);
  if ((kind === "embedding" && !settings.semanticSearchEnabled) || (kind === "tagging" && !settings.autoTaggingEnabled)) return [];
  // An expired running lease belongs to a worker that stopped before it could
  // complete the job. Reclaim it alongside pending/retrying work so a local
  // server restart cannot strand an embedding forever.
  const rows = await db.select().from(aiEnrichmentJobs).where(and(eq(aiEnrichmentJobs.kind, kind), inArray(aiEnrichmentJobs.status, ["pending", "retrying", "running"]), lte(aiEnrichmentJobs.nextRunAt, now), lte(aiEnrichmentJobs.leaseUntil, now))).orderBy(aiEnrichmentJobs.nextRunAt, aiEnrichmentJobs.id).limit(Math.min(Math.max(limit, 1), 20));
  const claimed: AiJob[] = [];
  for (const row of rows) {
    const token = crypto.randomUUID();
    const won = await db.update(aiEnrichmentJobs).set({ status: "running", claimToken: token, leaseUntil: now + 120, attempts: sql`${aiEnrichmentJobs.attempts} + 1`, updatedAt: now }).where(and(eq(aiEnrichmentJobs.id, row.id), lte(aiEnrichmentJobs.nextRunAt, now), lte(aiEnrichmentJobs.leaseUntil, now))).returning();
    if (won[0]) claimed.push({ ...won[0], token });
  }
  return claimed;
}

export async function completeAiJob(db: AnansiDb, id: string, token: string, now = Math.floor(Date.now() / 1000)) {
  await db.update(aiEnrichmentJobs).set({ status: "complete", claimToken: null, leaseUntil: 0, updatedAt: now, lastError: null }).where(and(eq(aiEnrichmentJobs.id, id), eq(aiEnrichmentJobs.claimToken, token)));
}

export async function failAiJob(db: AnansiDb, id: string, token: string, attempts: number, error: string, now = Math.floor(Date.now() / 1000)) {
  const delay = Math.min(86_400, 60 * 2 ** Math.min(Math.max(attempts - 1, 0), 11));
  await db.update(aiEnrichmentJobs).set({ status: attempts >= 5 ? "failed" : "retrying", claimToken: null, leaseUntil: 0, nextRunAt: now + delay, updatedAt: now, lastError: error.slice(0, 500) }).where(and(eq(aiEnrichmentJobs.id, id), eq(aiEnrichmentJobs.claimToken, token)));
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
    changed += Number((result as { changes?: number }).changes ?? 0);
  }
  return changed;
}

export async function aiProgress(db: AnansiDb, kind?: AiJobKind) {
  const [row] = await db.select({ pending: sql<number>`sum(case when status in ('pending','retrying','running') then 1 else 0 end)`, failed: sql<number>`sum(case when status='failed' then 1 else 0 end)`, complete: sql<number>`sum(case when status='complete' then 1 else 0 end)` }).from(aiEnrichmentJobs).where(kind ? eq(aiEnrichmentJobs.kind, kind) : undefined);
  return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0), complete: Number(row?.complete ?? 0) };
}

/** Apply a bounded AI label set without overriding manual intent. */
export async function applyAiTags(db: AnansiDb, itemId: string, labels: string[], model: string, now = Math.floor(Date.now() / 1000)) {
  for (const raw of [...new Set(labels)]) {
    const label = raw.trim().toLowerCase();
    if (!label) continue;
    const [existing] = await db.select().from(tags).where(eq(tags.label, label)).limit(1);
    const tagId = existing?.id ?? `ai-${label}`;
    if (existing?.origin === "manual") continue;
    const [suppressed] = await db.select().from(itemTagOverrides).where(and(eq(itemTagOverrides.itemId, itemId), eq(itemTagOverrides.tagId, tagId), eq(itemTagOverrides.override, "suppressed"))).limit(1);
    if (suppressed) continue;
    await db.insert(tags).values({ id: tagId, label, origin: "ai" }).onConflictDoNothing();
    await db.insert(itemTags).values({ itemId, tagId, provenance: "ai", model, appliedAt: now }).onConflictDoNothing();
  }
}

export { aiEnrichmentJobs, aiSettings, itemEmbeddings };
