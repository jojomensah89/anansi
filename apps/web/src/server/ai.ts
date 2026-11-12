import { TOPIC_DEFINITIONS, canonicalizeTopicIds } from "@anansi/db";

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
  embedBatch?(texts: readonly string[]): Promise<number[][]>;
}

/** Text-generation seam used by hosted and local automatic-tag workers. */
export interface TagGenerationProvider {
  readonly model: string;
  generateTags(text: string, max?: number): Promise<string[]>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize untrusted model output before it can become a database label.
 * Cloudflare returns a JSON array while Ollama uses an object with `tags`.
 */
export function normalizeTags(value: unknown, max = 5): string[] {
  const parsed = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tags)
      ? value.tags
      : undefined;
  if (!parsed || parsed.length > max) throw new AiProviderError("malformed", "AI tags must be an array");
  const labels = parsed.flatMap((v) => {
    if (typeof v !== "string") return [];
    const label = v.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 48).toLowerCase();
    return label ? [label] : [];
  });
  const unique = [...new Set(labels)];
  if (unique.length !== parsed.length || unique.length > max) throw new AiProviderError("malformed", "AI returned invalid or excessive tags");
  return unique;
}

/** Clef's request body names the model without the catalogue prefix. */
function clefModelName(model: string): "clef" | "clef-flash" | null {
  const name = model.split("/").pop() ?? "";
  if (name === "clef") return "clef";
  return name.startsWith("clef-flash") ? "clef-flash" : null;
}

/** A yes/no answer arrives as a bare probability or wrapped in an object. */
function yesProbability(answer: unknown): number | null {
  if (typeof answer === "number") return Number.isFinite(answer) ? answer : null;
  if (typeof answer === "boolean") return answer ? 1 : 0;
  if (!isRecord(answer)) return null;
  for (const key of ["noul", "probability", "yes", "score", "value"]) {
    const nested = yesProbability(answer[key]);
    if (nested !== null) return nested;
  }
  return null;
}

const topicQuestion = (topic: (typeof TOPIC_DEFINITIONS)[number], subject: string) => {
  const description = (topic as { description?: string }).description;
  return { type: "noul", instructions: `Is ${subject} mainly about ${topic.label}?${description ? ` ${description}` : ""}` };
};

const clefAnswers = (output: unknown): Record<string, unknown> | null => {
  if (!isRecord(output)) return null;
  if (isRecord(output.answers)) return output.answers;
  return isRecord(output.result) && isRecord(output.result.answers) ? output.result.answers : null;
};

/** The single best topic is kept from this probability; it is usually right even when Clef hedges. */
export const BEST_TOPIC_MIN = 0.3;
/** Further topics need a clear yes. */
export const EXTRA_TOPIC_MIN = 0.5;

/** The best topic at 0.3 or above plus others at 0.5 or above; null when no answer was readable. */
export function topicsFromAnswers(answer: (topicId: string) => unknown, max: number): string[] | null {
  const read = TOPIC_DEFINITIONS.map((topic) => ({ id: topic.id as string, probability: yesProbability(answer(topic.id)) }));
  if (read.every(({ probability }) => probability === null)) return null;
  const ranked = read.flatMap(({ id, probability }) => probability !== null ? [{ id, probability }] : []).sort((a, b) => b.probability - a.probability);
  const kept = ranked.filter(({ probability }, index) => probability >= (index === 0 ? BEST_TOPIC_MIN : EXTRA_TOPIC_MIN));
  return canonicalizeTopicIds(kept.slice(0, max).map(({ id }) => id), max);
}

/**
 * Clef is a decision model, not chat: it reads the save once and answers one
 * yes/no question per topic with a probability. A save whose best answer is
 * under 0.3 has no topic, which is a valid result.
 */
async function generateClefTags(ai: AiBinding, model: string, clef: "clef" | "clef-flash", text: string, max: number): Promise<string[]> {
  const questions = Object.fromEntries(TOPIC_DEFINITIONS.map((topic) => [topic.id, topicQuestion(topic, "this save")]));
  const output = await ai.run(model, { model: clef, state: text.slice(0, MAX_TEXT), questions }).catch((error) => { throw classifyAiError(error); });
  const answers = clefAnswers(output);
  if (!answers) throw new AiProviderError("malformed", "Workers AI returned no Clef answers");
  const topics = topicsFromAnswers((id) => answers[id], max);
  if (!topics) throw new AiProviderError("malformed", "Workers AI returned unreadable Clef answers");
  return topics;
}

/** Clef takes 64 questions a request; five saves ask 55 of them. */
export const CLEF_SAVES_PER_CALL = Math.max(1, Math.floor(64 / TOPIC_DEFINITIONS.length));
/** Enough of a save to tell its topic, and small enough to pack five together. */
const PACKED_TEXT = 2_000;

/**
 * Several saves in one Clef request. Question ids are `s<index>.<topic>`.
 * A save whose answers cannot be read is asked again on its own, so one odd
 * reply never costs the rest of the group.
 */
async function generateClefTagsPacked(ai: AiBinding, model: string, clef: "clef" | "clef-flash", texts: readonly string[], max: number): Promise<Array<string[] | AiProviderError>> {
  const single = (text: string) => generateClefTags(ai, model, clef, text, max).catch((error) => error instanceof AiProviderError ? error : classifyAiError(error));
  if (texts.length === 1) return [await single(texts[0]!)];
  const state = texts.map((text, index) => ({ id: `s${index}`, text: text.slice(0, PACKED_TEXT) }));
  const questions = Object.fromEntries(texts.flatMap((_, index) => TOPIC_DEFINITIONS.map((topic) => [`s${index}.${topic.id}`, topicQuestion(topic, `save s${index}`)])));
  let answers: Record<string, unknown> | null = null;
  try {
    answers = clefAnswers(await ai.run(model, { model: clef, state, questions }));
  } catch (error) {
    const failure = classifyAiError(error);
    // Out of quota: asking again one by one would only spend more of it.
    if (failure.code === "quota") return texts.map(() => failure);
  }
  return Promise.all(texts.map(async (text, index) => {
    const nested = answers?.[`s${index}`];
    const topics = answers ? topicsFromAnswers((id) => answers[`s${index}.${id}`] ?? (isRecord(nested) ? nested[id] : undefined), max) : null;
    return topics ?? single(text);
  }));
}

/**
 * Topics for many saves at once. Each entry is that save's topics or the
 * error that stopped it, so one failure does not sink the batch.
 */
export async function generateTagsBatch(ai: AiBinding, model: string, texts: readonly string[], max = 3): Promise<Array<string[] | AiProviderError>> {
  const clef = clefModelName(model);
  if (!clef) {
    return Promise.all(texts.map((text) => generateTags(ai, model, text, max).catch((error) => error instanceof AiProviderError ? error : classifyAiError(error))));
  }
  const groups: string[][] = [];
  for (let offset = 0; offset < texts.length; offset += CLEF_SAVES_PER_CALL) groups.push(texts.slice(offset, offset + CLEF_SAVES_PER_CALL));
  return (await Promise.all(groups.map((group) => generateClefTagsPacked(ai, model, clef, group, max)))).flat();
}

/** Workers AI embedding models take an array of texts in one request. */
export async function embedBatch(ai: AiBinding, model: string, texts: readonly string[], dimensions: number): Promise<number[][]> {
  if (texts.length === 0) return [];
  const output = await ai.run(model, { text: texts.map((text) => text.slice(0, MAX_TEXT)) }).catch((error) => { throw classifyAiError(error); });
  const data = Array.isArray(output) ? output : (output as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new AiProviderError("malformed", "Workers AI returned an incomplete embedding batch");
  return data.map((vector) => validateVector(vector, dimensions));
}

export async function generateTags(ai: AiBinding, model: string, text: string, max = 3): Promise<string[]> {
  const clef = clefModelName(model);
  if (clef) return generateClefTags(ai, model, clef, text, max);
  const allowed = TOPIC_DEFINITIONS.map(({ id, label }) => `${id} (${label})`).join(", ");
  const prompt = `Return only a JSON array of up to ${max} topic IDs from this allowlist: ${allowed}. Do not invent labels or translate them.\n\n${text.slice(0, MAX_TEXT)}`;
  const output = await ai.run(model, { prompt }).catch((error) => { throw classifyAiError(error); });
  const raw = typeof output === "string"
    ? output
    : (output as { response?: unknown; result?: unknown })?.response ?? (output as { result?: unknown })?.result;
  let parsed: unknown;
  if (typeof output === "object" && output !== null && (Array.isArray(output) || Array.isArray((output as Record<string, unknown>).tags))) {
    parsed = output;
  } else if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { parsed = JSON.parse(cleaned); } catch { throw new AiProviderError("malformed", "Workers AI returned malformed tag JSON"); }
  } else if (Array.isArray(raw) || isRecord(raw)) {
    // Workers AI hands back already-parsed JSON when the model emits JSON.
    parsed = raw;
  } else {
    throw new AiProviderError("malformed", "Workers AI returned no tag text");
  }
  return canonicalizeTopicIds(normalizeTags(parsed, max), max);
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
