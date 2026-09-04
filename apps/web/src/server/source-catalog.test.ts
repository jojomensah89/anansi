import { describe, expect, test } from "bun:test";
import type { ExtensionHealth } from "@anansi/db";
import { isToggleableSource, sourceCatalogueResponse } from "./source-catalog.ts";

const extension: ExtensionHealth = {
  connection: "never_connected",
  extensionVersion: null,
  lastSeenAt: null,
  activeClients: 0,
  queue: { queued: 0, uploading: 0, retrying: 0, failed: 0 },
  sources: {},
};

describe("source catalogue", () => {
  test("returns every product source when the library is empty", () => {
    const result = sourceCatalogueResponse([], [], extension);
    expect(result.sources.map((source) => source.source)).toEqual([
      "x",
      "reddit",
      "tiktok",
      "web",
      "github",
    ]);
    expect(result.sources.every((source) => source.items === 0)).toBe(true);
  });

  test("keeps experimental and planned capabilities explicit", () => {
    const result = sourceCatalogueResponse([], [], extension);
    expect(result.sources.find((source) => source.source === "tiktok")?.support).toBe("experimental");
    expect(result.sources.find((source) => source.source === "github")?.support).toBe("coming_next");
    expect(isToggleableSource("github")).toBe(false);
    expect(isToggleableSource("x")).toBe(true);
  });
});
