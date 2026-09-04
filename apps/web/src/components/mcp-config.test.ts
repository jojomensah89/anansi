import { describe, expect, test } from "bun:test";
import { clientSnippet, MCP_CLIENTS, MCP_TOKEN_PLACEHOLDER } from "./mcp-config.ts";

describe("MCP client setup snippets", () => {
  test("covers every supported client", () => {
    expect(MCP_CLIENTS).toHaveLength(5);
    expect(MCP_CLIENTS.map((client) => client.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "vscode",
      "zed",
    ]);
    for (const client of MCP_CLIENTS) {
      const snippet = clientSnippet(client.id, "https://anansi.example/mcp");
      expect(snippet).toContain("https://anansi.example/mcp");
      expect(snippet).toContain(MCP_TOKEN_PLACEHOLDER);
      expect(snippet).not.toContain("MCP_TOKEN=");
    }
  });

  test("uses the CLI command for Claude Code", () => {
    expect(clientSnippet("claude-code", "/mcp")).toBe(
      'claude mcp add --transport http anansi /mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"',
    );
  });

  test("uses Codex's environment-backed bearer configuration", () => {
    expect(clientSnippet("codex", "/mcp")).toContain("bearer_token_env_var = \"MCP_TOKEN\"");
    expect(clientSnippet("codex", "/mcp")).toContain(MCP_TOKEN_PLACEHOLDER);
  });
});
