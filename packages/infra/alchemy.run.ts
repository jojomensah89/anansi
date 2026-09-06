import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { config } from "dotenv";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

config({ path: "../../.env" });
config({ path: "../../apps/web/.env" });

export const db = Cloudflare.D1.Database("database", {
  // Our migrations live beside the schema, not under src/. 0001 creates the
  // FTS5 virtual table and its triggers, which drizzle-kit cannot generate
  // and `db:push` would silently skip — so this must be a migration path,
  // never a push.
  // Alchemy rejects Drizzle's legacy meta/_journal.json, so the deploy script
  // mirrors only the canonical SQL files here. It also normalizes CRLF because
  // D1 otherwise parses trigger bodies as incomplete input.
  migrations: "./.alchemy/migrations",
});

/**
 * Thumbnails. The importer writes here directly rather than through a queue:
 * Queues need Workers Paid at $5/month, and fetching a webp is a few
 * kilobytes of I/O that the local importer can do for free.
 */
export const media = Cloudflare.R2.Bucket("media");

export const vectorize = Cloudflare.Vectorize.Index("vectors", {
  preset: "@cf/baai/bge-small-en-v1.5",
});

export const web = Cloudflare.Website.Vite("web", {
  rootDir: "../../apps/web",
  main: "src/worker.ts",
  // Drain the bounded media-recovery queue without requiring Workers Queues
  // or a public request to kick the processor.
  crons: ["*/5 * * * *"],
  compatibility: {
    flags: ["nodejs_compat"],
  },
  env: {
    DB: db,
    MEDIA: media,
    AI: Cloudflare.Workers.AI(),
    VECTORIZE: vectorize,
    // Secrets, not bindings: absent means the endpoint is closed rather than
    // open. A public ingest URL is an invitation to have someone else's
    // library merged into yours.
    LIBRARY_TOKEN: Config.redacted("LIBRARY_TOKEN"),
    INGEST_TOKEN: Config.redacted("INGEST_TOKEN"),
    MCP_TOKEN: Config.redacted("MCP_TOKEN"),
  },
  dev: {
    port: 3001,
  },
});

export type WebEnv = Cloudflare.InferEnv<typeof web>;

export default Alchemy.Stack(
  "anansi",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const webWorker = yield* web;

    return {
      web: webWorker.url,
    };
  }),
);
