import { describe, expect, test } from "bun:test";
import { AiProviderError, embed, generateTags, reciprocalRankFusion } from "./ai.ts";

describe("Workers AI adapters", () => {
  test("normalizes strict tag JSON and rejects malformed output", async () => {
    const ai = { run: async () => ({ response: '["Design", "design", "\u0000bad"]' }) };
    await expect(generateTags(ai, "model", "text")).rejects.toBeInstanceOf(AiProviderError);
    const good = { run: async () => ({ response: '["Design", "Research"]' }) };
    await expect(generateTags(good, "model", "text")).resolves.toEqual(["design", "research"]);
  });

  test("accepts Workers AI embedding response shapes", async () => {
    await expect(embed({ run: async () => ({ data: [[1, 2, 3]] }) }, "model", "text")).resolves.toEqual([1, 2, 3]);
  });

  test("fuses ranks deterministically with item id tie-breaks", () => {
    expect(reciprocalRankFusion([[{ id: "b" }, { id: "a" }], [{ id: "a" }, { id: "b" }]])).toEqual([
      { id: "a", score: 0.03252247488101534 },
      { id: "b", score: 0.03252247488101534 },
    ]);
  });
});
