import { createFileRoute } from "@tanstack/react-router";
import { handleMcp } from "../server/mcp.ts";
import { serverEnv } from "../server/env.ts";

/**
 * The remote MCP endpoint: the same four tools the CLI serves over stdio,
 * reachable as a URL. This is the line the spec calls the reason the
 * migration is worth doing at all.
 */
export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { db, mcpToken } = await serverEnv();
        return handleMcp({ db, token: mcpToken }, request);
      },
      GET: async ({ request }) => {
        const { db, mcpToken } = await serverEnv();
        return handleMcp({ db, token: mcpToken }, request);
      },
    },
  },
});
