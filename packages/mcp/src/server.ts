import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnansiDb } from "@anansi/db";
import { registerTools, type ToolOptions } from "./tools.ts";

export function createAnansiServer(db: AnansiDb, beforeSearch?: () => Promise<unknown>, options: ToolOptions = {}): McpServer {
  const server = new McpServer({ name: "anansi", version: "0.1.0" });
  registerTools(server, db, beforeSearch, options);
  return server;
}
