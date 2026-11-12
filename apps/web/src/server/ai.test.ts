import { describe, expect, test } from "bun:test";
import { TOPIC_DEFINITIONS } from "@anansi/db";
import { AiProviderError, createEmbeddingProvider, embed, generateTags, reciprocalRankFusion, topicsFromAnswers } from "./ai.ts";

describe("Workers AI adapters", () => {
  test("normalizes strict tag JSON and rejects malformed output", async () => {
    const ai = { run: async () => ({ response: '["Design", "design", "\u0000bad"]' }) };
    await expect(generateTags(ai, "model", "text")).rejects.toBeInstanceOf(AiProviderError);
    const good = { run: async () => ({ response: '["Design", "AI / ML"]' }) };
    await expect(generateTags(good, "model", "text")).resolves.toEqual(["design", "ai-ml"]);

    const fenced = { run: async () => ({ response: '```json\n["Design", "AI / ML"]\n```' }) };
    await expect(generateTags(fenced, "@cf/custom/chat", "text")).resolves.toEqual(["design", "ai-ml"]);

    const directArray = { run: async () => ["Design", "AI / ML"] };
    await expect(generateTags(directArray, "@cf/custom/chat", "text")).resolves.toEqual(["design", "ai-ml"]);

    const parsedResponse = { run: async () => ({ response: ["design"] }) };
    await expect(generateTags(parsedResponse, "@cf/custom/chat", "text")).resolves.toEqual(["design"]);
  });

  test("asks Clef one yes/no question per topic and keeps the likeliest", async () => {
    const calls: Array<{ model: string; input: any }> = [];
    const answers: Record<string, unknown> = { design: { noul: 0.7 }, "ai-ml": { noul: 0.9 }, security: 0.6, finance: { noul: 0.55 }, health: { noul: 0.1 } };
    const ai = { run: async (model: string, input: unknown) => { calls.push({ model, input }); return { model: "clef-flash", answers, usage: {} }; } };
    await expect(generateTags(ai, "@cf/cloudflare/clef-flash", "a save")).resolves.toEqual(["ai-ml", "design", "security"]);
    expect(calls[0]!.model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0]!.input.model).toBe("clef-flash");
    expect(calls[0]!.input.state).toBe("a save");
    expect(Object.keys(calls[0]!.input.questions)).toHaveLength(TOPIC_DEFINITIONS.length);
    expect(calls[0]!.input.questions.design).toEqual({ type: "noul", instructions: "Is this save mainly about Design? UI, UX, graphic design, typography and visual work." });

    const none = { run: async () => ({ answers: { design: { noul: 0.2 } } }) };
    await expect(generateTags(none, "@cf/cloudflare/clef", "text")).resolves.toEqual([]);
    const broken = { run: async () => ({ response: "[]" }) };
    await expect(generateTags(broken, "@cf/cloudflare/clef-flash", "text")).rejects.toMatchObject({ code: "malformed" });
  });

  test("accepts Workers AI embedding response shapes", async () => {
    await expect(embed({ run: async () => ({ data: [[1, 2, 3]] }) }, "model", "text")).resolves.toEqual([1, 2, 3]);
  });

  test("rejects malformed or wrong-dimension provider vectors", async () => {
    const provider = createEmbeddingProvider({ run: async () => ({ data: [[1, 2]] }) }, "model", 3);
    await expect(provider.embed("text")).rejects.toMatchObject({ code: "dimension" });
  });

  test("fuses ranks deterministically with item id tie-breaks", () => {
    expect(reciprocalRankFusion([[{ id: "b" }, { id: "a" }], [{ id: "a" }, { id: "b" }]])).toEqual([
      { id: "a", score: 0.03252247488101534 },
      { id: "b", score: 0.03252247488101534 },
    ]);
  });
});

describe("choosing topics from Clef's answers", () => {
  const pick = (answers: Record<string, number>) => topicsFromAnswers((id) => answers[id] ?? 0, 3);

  test("keeps a hedged best topic so obvious saves are not left untagged", () => {
    expect(pick({ "ai-ml": 0.42, learning: 0.35 })).toEqual(["ai-ml"]);
  });

  test("needs a clear yes for every topic after the best", () => {
    expect(pick({ entertainment: 0.9, gaming: 0.62, music: 0.49 })).toEqual(["entertainment", "gaming"]);
  });

  test("leaves a save untagged when nothing fits", () => {
    expect(pick({ finance: 0.29, health: 0.1 })).toEqual([]);
  });

  test("never keeps more than three", () => {
    expect(pick({ "web-dev": 0.9, "ai-ml": 0.8, devops: 0.7, security: 0.6 })).toHaveLength(3);
  });
});
