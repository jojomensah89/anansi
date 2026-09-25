import startEntry from "@tanstack/react-start/server-entry";
import { openD1 } from "@anansi/db/d1";
import { fetchPendingMedia } from "./server/media.ts";
import { applyAiTags, getAiSettings, reconcileAiJobs, searchableText } from "@anansi/db";
import { createAiJobRunner } from "./server/ai-job-runner.ts";
import { createEmbeddingProvider, createVectorIndex, generateTags, type AiBinding, type VectorizeBinding } from "./server/ai.ts";
import { prepareSemanticItem, publishSemanticItem } from "./server/semantic-embedding.ts";
import { drainSemanticVectorDeletes } from "./server/semantic-vector-cleanup.ts";

type WorkerBindings = Pick<Env, "DB" | "MEDIA"> & {
  AI?: AiBinding;
  VECTORIZE?: VectorizeBinding;
};

export async function runMediaSchedule(env: WorkerBindings): Promise<void> {
  await fetchPendingMedia(openD1(env.DB), { bucket: env.MEDIA, runtime: "worker" });
}

export async function runAiSchedule(env: WorkerBindings): Promise<void> {
  const db = openD1(env.DB);
  const settings = await getAiSettings(db);
  const vectorize = env.VECTORIZE;
  const vectorIndex = vectorize ? createVectorIndex(vectorize, settings.embeddingDimensions) : undefined;
  await drainSemanticVectorDeletes(db, vectorIndex, 100);
  const ai = env.AI;
  if (!ai) return;
  // Keep the whole cron invocation comfortably below D1's free-tier query
  // budget; subsequent runs continue the durable reconciliation.
  await reconcileAiJobs(db, 12);
  const embeddingProvider = createEmbeddingProvider(ai, settings.embeddingModel, settings.embeddingDimensions);
  const embeddingRunner = createAiJobRunner({
    db,
    batchSize: 2,
    enabled: Boolean(vectorize),
    executor: {
      kind: "embedding",
      model: settings.embeddingModel,
      prepare: async (item) => prepareSemanticItem(db, item, embeddingProvider, { hosted: true }),
      publish: async (item, _job, prepared) => {
        if (vectorIndex) await publishSemanticItem(db, item.id, prepared, { index: vectorIndex });
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
  await drainSemanticVectorDeletes(db, vectorIndex, 100);
}

export default {
  fetch: startEntry.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerBindings): Promise<void> {
    await runMediaSchedule(env);
    await runAiSchedule(env);
  },
};
