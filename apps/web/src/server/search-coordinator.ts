import { searchItemsPage, getAiSettings, consumeSemanticCredits, type AnansiDb, type SearchOptions } from "@anansi/db";
import { createEmbeddingProvider, createVectorIndex, type AiBinding, type VectorizeBinding } from "./ai.ts";
import { hybridSearch } from "./semantic-search.ts";
/** Shared HTTP/MCP search seam: one runtime and one budget debit. */
export async function coordinateSearch(env: {db: AnansiDb; ai?: AiBinding; vectorize?: VectorizeBinding}, options: SearchOptions) {
  const page = await searchItemsPage(env.db, options);
  const settings = await getAiSettings(env.db);
  const runtime = env.ai && env.vectorize ? {
    provider: createEmbeddingProvider(env.ai, settings.embeddingModel, settings.embeddingDimensions),
    index: createVectorIndex(env.vectorize, settings.embeddingDimensions),
    charge: async (text: string) => (await consumeSemanticCredits(env.db,text)).allowed,
  } : undefined;
  return hybridSearch(env.db, options.query, options, page, {enabled:settings.semanticSearchEnabled === 1,dimensions:settings.embeddingDimensions,generation:settings.semanticGeneration},runtime);
}
