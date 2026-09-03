import { openD1 } from "@anansi/db/d1";
import { env } from "@anansi/env/server";
import type { AnansiDb } from "@anansi/db";

/**
 * The Worker's view of the world, in one place.
 *
 * `env` comes from `cloudflare:workers` and is typed from the bindings
 * declared in alchemy.run.ts, so adding a binding there is what makes it
 * appear here — there is no second list to keep in step.
 */
export function serverEnv(): { db: AnansiDb; ingestToken?: string; mcpToken?: string } {
  return {
    db: openD1(env.DB),
    ingestToken: env.INGEST_TOKEN,
    mcpToken: env.MCP_TOKEN,
  };
}
