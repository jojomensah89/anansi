export const MCP_TOKEN_PLACEHOLDER = "<YOUR_API_KEY>";
export const MCP_CLIENTS = [
 {id:"claude-code",label:"Claude Code",glyph:"C"},
 {id:"claude-desktop",label:"Claude Desktop / claude.ai",glyph:"C"},
 {id:"cursor",label:"Cursor",glyph:"C"},
 {id:"vscode",label:"VS Code",glyph:"VS"},
] as const;
export type McpClientId = (typeof MCP_CLIENTS)[number]["id"];
export function clientSnippet(client:McpClientId, endpoint:string, mode:"oauth"|"key"="oauth"):string {
 const headers = mode === "key" ? {Authorization:`Bearer ${MCP_TOKEN_PLACEHOLDER}`} : undefined;
 if(client === "claude-code") return `claude mcp add --transport http anansi ${endpoint}${headers ? ` --header "Authorization: Bearer ${MCP_TOKEN_PLACEHOLDER}"` : ""}`;
 if(client === "claude-desktop") return headers ? `${endpoint}\nAuthorization: Bearer ${MCP_TOKEN_PLACEHOLDER}` : endpoint;
 const config = {url:endpoint,...(headers ? {headers} : {})};
 return JSON.stringify(client === "vscode" ? {servers:{anansi:{type:"http",...config}}} : {mcpServers:{anansi:config}},null,2);
}
