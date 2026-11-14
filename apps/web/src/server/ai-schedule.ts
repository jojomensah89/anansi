import { openD1 } from "@anansi/db/d1";
import { type AnansiDb, getAiSettings, reconcileAiJobs } from "@anansi/db";
import { drainAi } from "./ai-drain.ts";
import { createVectorIndex, type AiBinding, type VectorizeBinding } from "./ai.ts";
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
  // Reconciliation queues saves whose content changed since they were
  // tagged or indexed; saves never queued are picked up by the pass itself.
  await reconcileAiJobs(db, 12);
  // The same bounded bulk pass the settings page drives, as the fallback.
  await drainAi(db, { ai, vectorize }, { settings });
  await drainSemanticVectorDeletes(db, vectorIndex, 100);
}

