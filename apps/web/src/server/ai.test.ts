import { describe, expect, test } from "bun:test";
import { AiProviderError, createEmbeddingProvider, embed, generateTags, reciprocalRankFusion } from "./ai.ts";

describe("Workers AI adapters", () => {
  test("normalizes strict tag JSON and rejects malformed output", async () => {
    const ai = { run: async () => ({ response: '["Design", "design", "\u0000bad"]' }) };
    await expect(generateTags(ai, "model", "text")).rejects.toBeInstanceOf(AiProviderError);
    const good = { run: async () => ({ response: '["Design", "AI / ML"]' }) };
    await expect(generateTags(good, "model", "text")).resolves.toEqual(["design", "ai-ml"]);

    const fenced = { run: async () => ({ response: '```json\n["Design", "AI / ML"]\n```' }) };
    await expect(generateTags(fenced, "@cf/clef-flash-9b", "text")).resolves.toEqual(["design", "ai-ml"]);

    const directArray = { run: async () => ["Design", "AI / ML"] };
    await expect(generateTags(directArray, "@cf/clef-flash-9b", "text")).resolves.toEqual(["design", "ai-ml"]);
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
