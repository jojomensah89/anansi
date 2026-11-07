import { authorizeClient } from "./clients.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAnansiServer } from "@anansi/mcp";
import { extensionHealth, requestPlatformSync, getSyncSettings, type AnansiDb } from "@anansi/db";

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
  const denied = await authorizeClient(env, request);
  if (denied) return denied;

  // Stateless: every request builds its own server and transport. A Worker
  // has no durable process to keep a session in, and the four tools are all
  // pure reads, so there is no session worth keeping.
  // The web-standard transport, not the node one: a Worker has Request and
  // Response, not req/res streams.
  const server = createAnansiServer(env.db, async () => {
    const now = Math.floor(Date.now()/1000);
    const [requested, health, settings] = await Promise.all([requestPlatformSync(env.db, now, "agent"), extensionHealth(env.db, now), getSyncSettings(env.db)]);
    return {browserOffline: health.connection !== "connected", platforms: Object.fromEntries(["x", "reddit", "github", "tiktok"].map(source => [source, {
      requested: requested.includes(source), browser: health.sources[source as keyof typeof health.sources] ?? null,
      ...(source === "github" ? {publicCheckedAt: settings.githubCheckedAt, publicError: settings.githubError} : {}),
    }]))};
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}
