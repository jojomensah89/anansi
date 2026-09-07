import { describe, expect, test } from "bun:test";
import { AiProviderError, createEmbeddingProvider, embed, generateTags, reciprocalRankFusion } from "./ai.ts";
import { LocalVectorIndex } from "./local-vector-index.ts";

describe("Workers AI adapters", () => {
  test("normalizes strict tag JSON and rejects malformed output", async () => {
    const ai = { run: async () => ({ response: '["Design", "design", "\u0000bad"]' }) };
    await expect(generateTags(ai, "model", "text")).rejects.toBeInstanceOf(AiProviderError);
    const good = { run: async () => ({ response: '["Design", "AI / ML"]' }) };
    await expect(generateTags(good, "model", "text")).resolves.toEqual(["design", "ai-ml"]);
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

  test("local index replaces, deletes, bounds, and tie-breaks deterministically", async () => {
    const index = new LocalVectorIndex(2);
    await index.upsert([
      { id: "b", values: [1, 0] },
      { id: "a", values: [1, 0] },
      { id: "c", values: [0, 1] },
    ]);
    await expect(index.query([1, 0], { topK: 2 })).resolves.toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 1 },
    ]);
    await index.upsert([{ id: "b", values: [0, 1] }]);
    await index.deleteByIds(["c"]);
    await expect(index.query([1, 0])).resolves.toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 0 },
    ]);
  });
});
