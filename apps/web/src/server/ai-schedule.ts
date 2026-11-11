import { openD1 } from "@anansi/db/d1";
import { type AnansiDb, applyAiTags, getAiSettings, reconcileAiJobs, searchableText } from "@anansi/db";
import { createAiJobRunner } from "./ai-job-runner.ts";
import { createEmbeddingProvider, createVectorIndex, generateTags, type AiBinding, type VectorizeBinding } from "./ai.ts";
import { prepareSemanticItem, publishSemanticItem } from "./semantic-embedding.ts";
import { drainSemanticVectorDeletes } from "./semantic-vector-cleanup.ts";

export async function runAiSchedule(env: { DB: D1Database; AI?: AiBinding; VECTORIZE?: VectorizeBinding }): Promise<void> {
  const db = openD1(env.DB);
  return runAiJobs(db, env);
}

export async function runAiJobs(db: AnansiDb, env: { AI?: AiBinding; VECTORIZE?: VectorizeBinding }): Promise<void> {
  const settings = await getAiSettings(db);
  const vectorize = env.VECTORIZE;
  const vectorIndex = vectorize ? createVectorIndex(vectorize, settings.embeddingDimensions) : undefined;
  await drainSemanticVectorDeletes(db, vectorIndex, 100);
  const ai = env.AI;
  if (!ai || (!settings.semanticSearchEnabled && !settings.autoTaggingEnabled)) return;
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

