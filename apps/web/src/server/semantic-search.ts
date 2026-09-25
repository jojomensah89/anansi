import { hydrateSemanticChunkMatches, type searchItemsPage, type AnansiDb, type SearchHit, type SearchOptions } from "@anansi/db";
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
	/** Hosted providers debit the per-library monthly workload budget before inference. */
	charge?: (text: string) => Promise<boolean>;
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
  settings: { enabled: boolean; dimensions?: number; generation?: number },
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
    if (runtime.charge && !(await runtime.charge(query))) throw new AiProviderError("quota", "monthly semantic credit cap reached");
    const vector = await runtime.provider.embed(query);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
    const nearest = await runtime.index.query(vector, { topK: Math.min(Math.max(limit * 10, 50), 100) });
    // An empty/warming sidecar is a normal state. Preserve the lexical page
    // until the first vector is indexed rather than turning a successful
    // provider call into an empty result set.
    if (nearest.length === 0) return { ...base, semantic: withSnapshot({ enabled: true, applied: false }) };
    const hydrated = await hydrateSemanticChunkMatches(db, nearest, query, runtime.provider.model, settings.generation ?? 1, opts);
    const semanticById = new Map(hydrated.map((item) => [item.id, item]));
    // Keep the best matching chunk excerpt even when the parent also appeared
    // in FTS; all other card data remains the canonical D1 projection.
    const itemsById = new Map(lexical.items.map((item) => [item.id, semanticById.get(item.id) ?? item]));
    for (const item of hydrated) itemsById.set(item.id, item);
    const lexicalRanks = lexical.items.map((item) => ({ id: item.id }));
    const semanticRanks = hydrated.map((item) => ({ id: item.id, score: item.score }));
    const order = reciprocalRankFusion([lexicalRanks, semanticRanks]);
    const items: SearchHit[] = [];
    for (const { id, score } of order) {
      const item = itemsById.get(id);
      if (item) items.push({ ...item, score });
      if (items.length >= limit) break;
    }
    return { items, nextCursor: null, semantic: withSnapshot({ enabled: true, applied: true }) };
  } catch (error) {
    const degradedReason = reasonFor(error);
    const degraded: SemanticSearchStatus = { enabled: true, applied: false, degradedReason };
    if (snapshot) degraded.state = degradedReason === "provider-unavailable" ? "unavailable" : degradedReason === "quota" ? "paused" : "error";
    return { ...base, semantic: withSnapshot(degraded) };
  }
}
