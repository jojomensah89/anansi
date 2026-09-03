import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAnansiServer } from "@anansi/mcp";
import type { AnansiDb } from "@anansi/db";

/**
 * The same four tools, over HTTP.
 *
 * This is the line the spec calls the whole reason Cloudflare is worth the
 * migration: a remote MCP server is a URL someone else can point their own
 * agent at, with nothing to install. A personal tool becomes a product here
 * and nowhere earlier.
 *
 * Note what is NOT here — no second implementation of search, no reimplemented
 * tool schemas. `createAnansiServer` is the identical function the stdio CLI
 * calls. If these ever disagree it will be because someone added a fifth tool
 * in one place, and there is only one place to add it.
 */
export interface McpEnv {
  db: AnansiDb;
  /** Absent means the endpoint is closed; a public library is opt-in. */
  token?: string;
}

export async function handleMcp(env: McpEnv, request: Request): Promise<Response> {
  if (!env.token) {
    return new Response(JSON.stringify({ error: "mcp endpoint is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.token}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Stateless: every request builds its own server and transport. A Worker
  // has no durable process to keep a session in, and the four tools are all
  // pure reads, so there is no session worth keeping.
  // The web-standard transport, not the node one: a Worker has Request and
  // Response, not req/res streams.
  const server = createAnansiServer(env.db);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}
