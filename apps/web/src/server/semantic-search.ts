import { hydrateSearchItems, type searchItemsPage, type AnansiDb, type SearchHit, type SearchOptions } from "@anansi/db";
import { AiProviderError, reciprocalRankFusion, type EmbeddingProvider, type VectorIndex } from "./ai.ts";

export type SemanticDegradedReason = "provider-unavailable" | "provider-failed" | "quota" | "dimension-mismatch" | "pagination-boundary";

export type SemanticRuntimeState = "ready" | "warming" | "unavailable" | "error" | "paused";

export interface SemanticRuntimeSnapshot {
  state: SemanticRuntimeState;
  model?: string;
  dimension?: number;
  pending?: number;
  indexed?: number;
}

export interface SemanticRuntime {
	provider: EmbeddingProvider;
	index: VectorIndex;
	/** True only for the local Ollama runtime; hosted responses omit it. */
	local?: boolean;
	status?: () => SemanticRuntimeSnapshot | Promise<SemanticRuntimeSnapshot>;
}

export interface SemanticSearchStatus {
  enabled: boolean;
  applied: boolean;
  degradedReason?: SemanticDegradedReason;
  state?: SemanticRuntimeState;
  model?: string;
  dimension?: number;
	pending?: number;
	indexed?: number;
	local?: boolean;
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
  settings: { enabled: boolean; dimensions?: number },
  runtime?: SemanticRuntime,
): Promise<HybridSearchResult> {
  const base = { items: lexical.items, nextCursor: lexical.nextCursor };
  if (!settings.enabled) return { ...base, semantic: { enabled: false, applied: false } };
  if (!runtime) return { ...base, semantic: { enabled: true, applied: false, degradedReason: "provider-unavailable" } };

  let snapshot: SemanticRuntimeSnapshot | undefined;
  try { snapshot = runtime.status ? await runtime.status() : undefined; } catch { /* status is advisory; search still gets a chance */ }
  const withSnapshot = (status: SemanticSearchStatus): SemanticSearchStatus => snapshot ? {
    ...status,
    ...(runtime.local ? { local: true } : {}),
    state: status.state ?? snapshot.state,
    model: status.model ?? snapshot.model,
    dimension: status.dimension ?? snapshot.dimension,
    pending: status.pending ?? snapshot.pending,
    indexed: status.indexed ?? snapshot.indexed,
  } : status;
  if (opts.cursor) return { ...base, semantic: withSnapshot({ enabled: true, applied: false, degradedReason: "pagination-boundary" }) };

  try {
    const expected = settings.dimensions;
    if (expected !== undefined && expected > 0 && ((runtime.provider.dimensions > 0 && runtime.provider.dimensions !== expected) || (runtime.index.dimensions > 0 && runtime.index.dimensions !== expected))) {
      throw new AiProviderError("dimension", "semantic components have incompatible dimensions");
    }
    if (runtime.provider.dimensions > 0 && runtime.index.dimensions > 0 && runtime.provider.dimensions !== runtime.index.dimensions) {
      throw new AiProviderError("dimension", "semantic components have incompatible dimensions");
    }
    const vector = await runtime.provider.embed(query);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
    const nearest = await runtime.index.query(vector, { topK: Math.min(Math.max(limit * 3, 20), 100) });
    // An empty/warming sidecar is a normal state. Preserve the lexical page
    // until the first vector is indexed rather than turning a successful
    // provider call into an empty result set.
    if (nearest.length === 0) return { ...base, semantic: withSnapshot({ enabled: true, applied: false }) };
    const lexicalIds = new Set(lexical.items.map((item) => item.id));
    const vectorOnlyIds: string[] = [];
    for (const match of nearest) if (!lexicalIds.has(match.id)) vectorOnlyIds.push(match.id);
    const hydrated = await hydrateSearchItems(db, vectorOnlyIds, opts);
    const itemsById = new Map([...lexical.items, ...hydrated].map((item) => [item.id, item]));
    const lexicalRanks = lexical.items.map((item) => ({ id: item.id }));
    const semanticRanks: Array<{ id: string; score: number }> = [];
    for (const match of nearest) if (itemsById.has(match.id)) semanticRanks.push({ id: match.id, score: match.score });
    const order = reciprocalRankFusion([lexicalRanks, semanticRanks]);
    const items: SearchHit[] = [];
    for (const { id } of order) {
      const item = itemsById.get(id);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    return { items, nextCursor: null, semantic: withSnapshot({ enabled: true, applied: true }) };
  } catch (error) {
    const degradedReason = reasonFor(error);
    const degraded: SemanticSearchStatus = { enabled: true, applied: false, degradedReason };
    if (snapshot) degraded.state = degradedReason === "provider-unavailable" ? "unavailable" : "error";
    return { ...base, semantic: withSnapshot(degraded) };
  }
}
