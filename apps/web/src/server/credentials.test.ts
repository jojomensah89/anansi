import { describe, expect, test } from "bun:test";
import { resolveServerCredentials } from "./credentials.ts";

describe("server credential resolution", () => {
  test("role-specific credentials override the shared secret independently", () => {
    expect(resolveServerCredentials({
      ANANSI_SECRET: " shared-secret ",
      LIBRARY_TOKEN: " library-secret ",
      INGEST_TOKEN: " ingest-secret ",
      MCP_TOKEN: " mcp-secret ",
    })).toEqual({
      libraryToken: "library-secret",
      ingestToken: "ingest-secret",
      mcpToken: "mcp-secret",
    });
  });

  test("the shared secret remains the fallback for roles without an override", () => {
    expect(resolveServerCredentials({
      ANANSI_SECRET: " shared-secret ",
      INGEST_TOKEN: " ingest-secret ",
    })).toEqual({
      libraryToken: "shared-secret",
      ingestToken: "ingest-secret",
      mcpToken: "shared-secret",
    });
  });

  test("blank role values are absent and blank shared secrets fail closed", () => {
    expect(resolveServerCredentials({
      ANANSI_SECRET: "  \t ",
      LIBRARY_TOKEN: "",
      INGEST_TOKEN: " \n ",
      MCP_TOKEN: 42,
    })).toEqual({
      libraryToken: undefined,
      ingestToken: undefined,
      mcpToken: undefined,
    });
  });
});
