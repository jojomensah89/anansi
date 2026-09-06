import type { MediaSource } from "./media.ts";
import type { AnansiDb } from "@anansi/db";
import type { AiBinding, VectorizeBinding } from "./ai.ts";

export interface ServerEnv {
  db: AnansiDb;
  /** R2 binding in a Worker, a directory locally. Exactly one is set. */
  media: MediaSource;
  libraryToken?: string;
  allowedOrigins?: string[];
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Absent means the endpoint is closed, not open. */
  ingestToken?: string;
	mcpToken?: string;
	ai?: AiBinding;
	vectorize?: VectorizeBinding;
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
    // Vite's dev dependency scanner tries to resolve even literal dynamic
    // imports before this Worker-only branch can fall through to SQLite.
    // The module is supplied by workerd at runtime, so keep it out of the
    // local dependency graph.
    const { env, waitUntil } = (await import(/* @vite-ignore */ "cloudflare:workers")) as {
      env: Record<string, unknown>;
      waitUntil: (promise: Promise<unknown>) => void;
    };
    if (env?.DB) {
      const { openD1 } = await import("@anansi/db/d1");
      cached = {
        db: openD1(env.DB as D1Database),
        media: { bucket: env.MEDIA as MediaSource["bucket"], runtime: "worker" },
        libraryToken: env.LIBRARY_TOKEN as string | undefined,
        waitUntil,
        ingestToken: env.INGEST_TOKEN as string | undefined,
        mcpToken: env.MCP_TOKEN as string | undefined,
        ai: env.AI as AiBinding | undefined,
        vectorize: env.VECTORIZE as VectorizeBinding | undefined,
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
    media: { dir: process.env.ANANSI_MEDIA_DIR ?? "data/media" },
    libraryToken: process.env.LIBRARY_TOKEN,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3001,http://127.0.0.1:3001").split(",").map(v=>v.trim()).filter(Boolean),
    ingestToken: process.env.INGEST_TOKEN,
    mcpToken: process.env.MCP_TOKEN,
    source: "local",
  };
  return cached;
}
