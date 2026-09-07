import startEntry from "@tanstack/react-start/server-entry";
import { openD1 } from "@anansi/db/d1";
import { fetchPendingMedia } from "./server/media.ts";
import { applyAiTags, getAiSettings, reconcileAiJobs, searchableText, semanticText, upsertItemEmbedding } from "@anansi/db";
import { createAiJobRunner } from "./server/ai-job-runner.ts";
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
  const ai = env.AI;
  if (!ai) return;
  const db = openD1(env.DB);
  // Keep the whole cron invocation comfortably below D1's free-tier query
  // budget; subsequent runs continue the durable reconciliation.
  await reconcileAiJobs(db, 12);
  const settings = await getAiSettings(db);
  const vectorize = env.VECTORIZE;
  const embeddingProvider = createEmbeddingProvider(ai, settings.embeddingModel, settings.embeddingDimensions);
  const embeddingRunner = createAiJobRunner({
    db,
    batchSize: 2,
    enabled: Boolean(vectorize),
    executor: {
      kind: "embedding",
      model: settings.embeddingModel,
      prepare: async (item) => embeddingProvider.embed(semanticText(item)),
      publish: async (item, job, values) => {
        if (!vectorize) return;
        await vectorize.upsert([{ id: item.id, values }]);
        await upsertItemEmbedding(db, {
          itemId: item.id,
          model: settings.embeddingModel,
          dimensions: values.length,
          contentHash: job.contentHash,
        });
      },
    },
  });
  const taggingRunner = createAiJobRunner({
    db,
    batchSize: 2,
    executor: {
      kind: "tagging",
      model: settings.tagModel,
      prepare: async (item) => generateTags(ai, settings.tagModel, searchableText(item), 3),
      publish: async (item, _job, labels) => {
        await applyAiTags(db, item.id, labels, settings.tagModel);
      },
    },
  });
  // A hosted embedding job is not claimable without its required remote
  // projection. Leaving it pending preserves the attempt budget for recovery.
  await embeddingRunner.runOnce();
  await taggingRunner.runOnce();
}

export default {
  fetch: startEntry.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerBindings): Promise<void> {
    await runMediaSchedule(env);
    await runAiSchedule(env);
  },
};
