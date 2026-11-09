import {expect,test} from "bun:test";
import {clientSnippet,MCP_CLIENTS} from "./mcp-config.ts";
test("OAuth snippets use the endpoint without credentials",()=>{
 for(const client of MCP_CLIENTS){const snippet=clientSnippet(client.id,"https://fixture.invalid/mcp");expect(snippet).toContain("https://fixture.invalid/mcp");expect(snippet).not.toContain("Authorization");expect(snippet).not.toContain("MCP_TOKEN");}
 expect(clientSnippet("claude-code","/mcp")).toBe("claude mcp add --transport http anansi /mcp");
 expect(JSON.parse(clientSnippet("cursor","/mcp"))).toEqual({mcpServers:{anansi:{url:"/mcp"}}});
});
test("key snippets use explicit bearer authentication",()=>{for(const client of MCP_CLIENTS){const snippet=clientSnippet(client.id,"/mcp","key");expect(snippet).toContain("Authorization");expect(snippet).toContain("Bearer <YOUR_API_KEY>");expect(snippet).not.toContain("MCP_TOKEN");}});
