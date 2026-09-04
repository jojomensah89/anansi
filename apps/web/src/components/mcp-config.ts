export const MCP_TOKEN_PLACEHOLDER = "<YOUR_MCP_TOKEN>";

export const MCP_CLIENTS = [
  { id: "claude-code", label: "Claude Code", glyph: "✳" },
  { id: "codex", label: "Codex", glyph: "C" },
  { id: "cursor", label: "Cursor", glyph: "◆" },
  { id: "vscode", label: "VS Code", glyph: "VS" },
  { id: "zed", label: "Zed", glyph: "Z" },
] as const;

export type McpClientId = (typeof MCP_CLIENTS)[number]["id"];

const authHeaders = {
  Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}`,
};

/**
 * Keep configuration generation pure and secret-free. The page may be
 * rendered on the server, so this function accepts the endpoint explicitly
 * instead of reading window or environment variables.
 */
export function clientSnippet(client: McpClientId, endpoint: string): string {
  switch (client) {
    case "claude-code":
      return `claude mcp add --transport http anansi ${endpoint} --header "Authorization: Bearer ${MCP_TOKEN_PLACEHOLDER}"`;
    case "codex":
      return `# Set MCP_TOKEN to ${MCP_TOKEN_PLACEHOLDER} before starting Codex.\n[mcp_servers.anansi]\nurl = "${endpoint}"\nbearer_token_env_var = "MCP_TOKEN"`;
    case "cursor":
      return JSON.stringify({ mcpServers: { anansi: { url: endpoint, headers: authHeaders } } }, null, 2);
    case "vscode":
      return JSON.stringify({ servers: { anansi: { type: "http", url: endpoint, headers: authHeaders } } }, null, 2);
    case "windsurf":
      return JSON.stringify({ mcpServers: { anansi: { serverUrl: endpoint, headers: authHeaders } } }, null, 2);
    case "zed":
      return JSON.stringify({ context_servers: { anansi: { source: "custom", url: endpoint, headers: authHeaders } } }, null, 2);
  }
}
