import { AiProviderError, type VectorIndex, type VectorMatch, validateVector } from "./ai.ts";

/**
 * Tiny in-memory cosine index for offline tests and developer smoke runs.
 * It is deliberately not a persistence layer: hosted users never need it.
 */
export class LocalVectorIndex implements VectorIndex {
  readonly #vectors = new Map<string, number[]>();

  constructor(readonly dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new AiProviderError("dimension", "vector index dimensions must be a positive integer");
    }
  }

  async upsert(vectors: Array<{ id: string; values: number[] }>): Promise<void> {
    for (const vector of vectors) this.#vectors.set(vector.id, [...validateVector(vector.values, this.dimensions, "vector")]);
  }

  async query(values: number[], options: { topK?: number } = {}): Promise<VectorMatch[]> {
    const query = validateVector(values, this.dimensions, "query vector");
    const topK = Math.min(Math.max(Math.floor(options.topK ?? 10), 0), this.#vectors.size);
    if (topK === 0) return [];
    const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(queryNorm) || queryNorm === 0) return [];
    return [...this.#vectors.entries()]
      .map(([id, vector]) => {
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        const score = norm === 0 ? 0 : vector.reduce((sum, value, index) => sum + value * query[index]!, 0) / (norm * queryNorm);
        return { id, score };
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.#vectors.delete(id);
  }
}
