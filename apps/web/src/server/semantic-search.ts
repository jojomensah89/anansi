import { hydrateSearchItems, searchItemsPage, type AnansiDb, type SearchHit, type SearchOptions } from "@anansi/db";
import { AiProviderError, reciprocalRankFusion, type EmbeddingProvider, type VectorIndex } from "./ai.ts";

export type SemanticDegradedReason = "provider-unavailable" | "provider-failed" | "quota" | "dimension-mismatch" | "pagination-boundary";

export interface SemanticSearchStatus {
  enabled: boolean;
  applied: boolean;
  degradedReason?: SemanticDegradedReason;
}

export interface HybridSearchResult {
  items: SearchHit[];
  nextCursor: string | null;
  semantic: SemanticSearchStatus;
}

function reasonFor(error: unknown): SemanticDegradedReason {
  if (error instanceof AiProviderError && error.code === "dimension") return "dimension-mismatch";
  if (error instanceof AiProviderError && error.code === "unavailable") return "provider-unavailable";
  if (error instanceof AiProviderError && error.code === "quota") return "quota";
  return "provider-failed";
}

/**
 * First-page hybrid retrieval. Lexical keyset cursors remain authoritative;
 * once semantic ranking is enabled we stop at the first page because a fused
 * relevance order does not have a safe BM25 cursor boundary yet.
 */
export async function hybridSearch(
  db: AnansiDb,
  query: string,
  opts: Omit<SearchOptions, "query">,
  lexical: Awaited<ReturnType<typeof searchItemsPage>>,
  settings: { enabled: boolean; dimensions: number },
  provider?: EmbeddingProvider,
  index?: VectorIndex,
): Promise<HybridSearchResult> {
  const base = { items: lexical.items, nextCursor: lexical.nextCursor };
  if (!settings.enabled) return { ...base, semantic: { enabled: false, applied: false } };
  if (!provider || !index) return { ...base, semantic: { enabled: true, applied: false, degradedReason: "provider-unavailable" } };
  if (opts.cursor) return { ...base, semantic: { enabled: true, applied: false, degradedReason: "pagination-boundary" } };

  try {
    if (provider.dimensions !== settings.dimensions || index.dimensions !== settings.dimensions) {
      throw new AiProviderError("dimension", "semantic components have incompatible dimensions");
    }
    const vector = await provider.embed(query);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
    const nearest = await index.query(vector, { topK: Math.min(Math.max(limit * 3, 20), 100) });
    const vectorOnlyIds = nearest.map((match) => match.id).filter((id) => !lexical.items.some((item) => item.id === id));
    const hydrated = await hydrateSearchItems(db, vectorOnlyIds, opts);
    const itemsById = new Map([...lexical.items, ...hydrated].map((item) => [item.id, item]));
    const lexicalRanks = lexical.items.map((item) => ({ id: item.id }));
    const semanticRanks = nearest.filter((match) => itemsById.has(match.id)).map((match) => ({ id: match.id, score: match.score }));
    const order = reciprocalRankFusion([lexicalRanks, semanticRanks]);
    const items = order.map(({ id }) => itemsById.get(id)).filter((item): item is SearchHit => Boolean(item)).slice(0, limit);
    return { items, nextCursor: null, semantic: { enabled: true, applied: true } };
  } catch (error) {
    return { ...base, semantic: { enabled: true, applied: false, degradedReason: reasonFor(error) } };
  }
}
