import startEntry from "@tanstack/react-start/server-entry";
import { openD1 } from "@anansi/db/d1";
import { fetchPendingMedia } from "./server/media.ts";
import { claimAiJobs, completeAiJob, failAiJob, getAiSettings, reconcileAiJobs, searchableText, semanticText, itemEmbeddings, itemTagOverrides, items, tags, itemTags } from "@anansi/db";
import { createEmbeddingProvider, generateTags, type AiBinding, type VectorizeBinding } from "./server/ai.ts";

interface WorkerBindings {
  DB: D1Database;
  MEDIA: {
    get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
    put(key: string, bytes: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  };
  AI?: AiBinding;
  VECTORIZE?: VectorizeBinding;
}

export async function runMediaSchedule(env: WorkerBindings): Promise<void> {
  await fetchPendingMedia(openD1(env.DB), { bucket: env.MEDIA, runtime: "worker" });
}

export async function runAiSchedule(env: WorkerBindings): Promise<void> {
  if (!env.AI) return;
  const db = openD1(env.DB);
  // Keep the whole cron invocation comfortably below D1's free-tier query
  // budget; subsequent runs continue the durable reconciliation.
  await reconcileAiJobs(db, 12);
  const settings = await getAiSettings(db);
  const embeddingProvider = createEmbeddingProvider(env.AI, settings.embeddingModel, settings.embeddingDimensions);
  for (const kind of ["embedding", "tagging"] as const) {
    const jobs = await claimAiJobs(db, kind, 2);
    for (const job of jobs) {
      try {
        const item = (await db.select().from(items)).find((candidate) => candidate.id === job.itemId);
        if (!item) { await completeAiJob(db, job.id, job.token); continue; }
        const text = searchableText(item);
        if (kind === "embedding") {
          const values = await embeddingProvider.embed(semanticText(item));
          if (env.VECTORIZE) await env.VECTORIZE.upsert([{ id: item.id, values }]);
          await db.insert(itemEmbeddings).values({ itemId: item.id, vectorId: item.id, model: settings.embeddingModel, dimensions: values.length, contentHash: job.contentHash, status: "complete", createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000) }).onConflictDoUpdate({ target: itemEmbeddings.itemId, set: { vectorId: item.id, model: settings.embeddingModel, dimensions: values.length, contentHash: job.contentHash, status: "complete", updatedAt: Math.floor(Date.now()/1000), lastError: null } });
        } else {
          const labels = await generateTags(env.AI, settings.tagModel, text);
          for (const label of labels) {
            const existingTag = (await db.select().from(tags)).find((tag) => tag.label === label);
            const id = existingTag?.id ?? `ai-${label}`;
            if (existingTag?.origin === "manual") continue;
            const suppressed = (await db.select().from(itemTagOverrides)).some((override) => override.itemId === item.id && override.tagId === id && override.override === "suppressed");
            if (suppressed) continue;
            if (!existingTag) await db.insert(tags).values({ id, label, origin: "ai" }).onConflictDoNothing();
            await db.insert(itemTags).values({ itemId: item.id, tagId: id, provenance: "ai", model: settings.tagModel, appliedAt: Math.floor(Date.now()/1000) }).onConflictDoNothing();
          }
        }
        await completeAiJob(db, job.id, job.token);
      } catch (error) {
        await failAiJob(db, job.id, job.token, job.attempts, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

export default {
  fetch: startEntry.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerBindings): Promise<void> {
    await runMediaSchedule(env);
    await runAiSchedule(env);
  },
};
