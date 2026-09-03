import type { AnansiDb } from "@anansi/db";

export interface ServerEnv {
  db: AnansiDb;
  /** Absent means the endpoint is closed, not open. */
  ingestToken?: string;
  mcpToken?: string;
  source: "d1" | "local";
}

/**
 * One env resolver, two runtimes.
 *
 * In a Worker this is the D1 binding declared in alchemy.run.ts. Everywhere
 * else — `bun run dev:web` on your laptop — it falls back to the same
 * data/anansi.db the CLI already filled. That is deliberate and not just a
 * convenience: the whole web app stays developable against the real 1,274
 * item library with no Cloudflare account, which is the same rule days 1-7
 * followed.
 *
 * Both imports are dynamic. `cloudflare:workers` does not resolve off-Worker
 * and `bun:sqlite` does not resolve on one, so neither may sit at module
 * scope; both are marked external in vite.config.ts so the bundler leaves
 * them alone.
 */
let cached: ServerEnv | undefined;

export async function serverEnv(): Promise<ServerEnv> {
  if (cached) return cached;

  try {
    const { env } = (await import("cloudflare:workers")) as {
      env: Record<string, unknown>;
    };
    if (env?.DB) {
      const { openD1 } = await import("@anansi/db/d1");
      cached = {
        db: openD1(env.DB as D1Database),
        ingestToken: env.INGEST_TOKEN as string | undefined,
        mcpToken: env.MCP_TOKEN as string | undefined,
        source: "d1",
      };
      return cached;
    }
  } catch {
    // Not running on a Worker. Expected during local development.
  }

  const { openLocalDb } = await import("@anansi/db/local");
  const path = process.env.ANANSI_DB_PATH ?? "data/anansi.db";
  cached = {
    db: openLocalDb(path) as unknown as AnansiDb,
    ingestToken: process.env.INGEST_TOKEN,
    mcpToken: process.env.MCP_TOKEN,
    source: "local",
  };
  return cached;
}
