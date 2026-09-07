/** Small injectable seams around Workers AI and Vectorize. */
export interface AiBinding { run(model: string, input: unknown): Promise<unknown> }
export interface VectorizeBinding {
  upsert(vectors: Array<{ id: string; values: number[] }>): Promise<unknown>;
  query(values: number[], options?: { topK?: number; returnMetadata?: boolean }): Promise<{ matches?: Array<{ id: string; score?: number }> }>;
  deleteByIds?(ids: string[]): Promise<unknown>;
}

/** Provider/index seams keep search testable without a Cloudflare account. */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface VectorMatch { id: string; score: number }

export interface VectorIndex {
  readonly dimensions: number;
  upsert(vectors: Array<{ id: string; values: number[] }>): Promise<void>;
  query(values: number[], options?: { topK?: number }): Promise<VectorMatch[]>;
  deleteByIds?(ids: string[]): Promise<void>;
}

export class AiProviderError extends Error {
  readonly code: "quota" | "unavailable" | "malformed" | "dimension";
  constructor(code: AiProviderError["code"], message: string) { super(message); this.name = "AiProviderError"; this.code = code; }
}

const MAX_TEXT = 12_000;

export function validateVector(values: unknown, dimensions: number, label = "embedding"): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new AiProviderError("dimension", "embedding dimensions must be a positive integer");
  if (!Array.isArray(values) || values.length !== dimensions || values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new AiProviderError("dimension", `${label} must contain exactly ${dimensions} finite values`);
  }
  return values as number[];
}

export async function embed(ai: AiBinding, model: string, text: string): Promise<number[]> {
  const output = await ai.run(model, { text: text.slice(0, MAX_TEXT) }).catch((error) => { throw classifyAiError(error); });
  const values = Array.isArray(output) ? output : (output as { data?: unknown })?.data;
  const vector = Array.isArray(values) && Array.isArray(values[0]) ? values[0] : values;
  if (!Array.isArray(vector) || vector.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new AiProviderError("malformed", "Workers AI returned an invalid embedding");
  return vector as number[];
}

export function createEmbeddingProvider(ai: AiBinding, model: string, dimensions: number): EmbeddingProvider {
  return {
    model,
    dimensions,
    embed: async (text) => validateVector(await embed(ai, model, text), dimensions),
  };
}

export function createVectorIndex(binding: VectorizeBinding, dimensions: number): VectorIndex {
  return {
    dimensions,
    upsert: async (vectors) => {
      vectors.forEach((vector) => validateVector(vector.values, dimensions, "vector"));
      await binding.upsert(vectors);
    },
    query: async (values, options) => {
      validateVector(values, dimensions, "query vector");
      const response = await binding.query(values, { ...options, returnMetadata: false });
      return (response.matches ?? []).flatMap((match) => typeof match.score === "number" && Number.isFinite(match.score)
        ? [{ id: match.id, score: match.score }]
        : []);
    },
    deleteByIds: binding.deleteByIds ? async (ids) => { await binding.deleteByIds?.(ids); } : undefined,
  };
}

export async function generateTags(ai: AiBinding, model: string, text: string, max = 5): Promise<string[]> {
  const output = await ai.run(model, { prompt: `Return only a JSON array of up to ${max} concise topic labels for this item.\n\n${text.slice(0, MAX_TEXT)}` }).catch((error) => { throw classifyAiError(error); });
  const raw = typeof output === "string" ? output : (output as { response?: unknown })?.response;
  if (typeof raw !== "string") throw new AiProviderError("malformed", "Workers AI returned no tag text");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AiProviderError("malformed", "Workers AI returned malformed tag JSON"); }
  if (!Array.isArray(parsed)) throw new AiProviderError("malformed", "Workers AI tags must be an array");
  const labels = parsed.filter((v): v is string => typeof v === "string").map((v) => v.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 48).toLowerCase()).filter(Boolean);
  const unique = [...new Set(labels)];
  if (unique.length !== parsed.length || unique.length > max) throw new AiProviderError("malformed", "Workers AI returned invalid or excessive tags");
  return unique;
}

export function classifyAiError(error: unknown): AiProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (/403|429|quota|capacity|limit/i.test(message)) return new AiProviderError("quota", message.slice(0, 500));
  return new AiProviderError("unavailable", message.slice(0, 500));
}

export function reciprocalRankFusion(ranked: Array<Array<{ id: string; score?: number }>>, k = 60) {
  const scores = new Map<string, number>();
  for (const list of ranked) list.forEach((item, index) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + index + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, score]) => ({ id, score }));
}
