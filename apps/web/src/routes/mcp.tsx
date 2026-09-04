import { createFileRoute } from "@tanstack/react-router";
import { McpServerPage } from "../components/mcp-server.tsx";
import { handleMcp } from "../server/mcp.ts";
import { serverEnv } from "../server/env.ts";

/**
 * GET is the human setup page; POST remains the stateless MCP transport used
 * by configured clients. Both live at the same public endpoint so setup copy
 * and client configuration cannot drift apart.
 */
export const Route = createFileRoute("/mcp")({
  component: McpServerPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { db, mcpToken } = await serverEnv();
        return handleMcp({ db, token: mcpToken }, request);
      },
    },
  },
});
