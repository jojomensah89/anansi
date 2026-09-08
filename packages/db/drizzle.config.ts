import { defineConfig } from "drizzle-kit";

/**
 * Local development only. The configured database path is SQLite. Hosted D1
 * migrations are applied by Alchemy during `bun run deploy` from the canonical
 * SQL files in this package's ./drizzle directory, after infra prepares them
 * for Alchemy. Do not run Wrangler or `db:push` for the hosted stack.
 *
 * `db:push` is deliberately not a script here. The FTS5 virtual table and its
 * three triggers live in a hand-written migration that push would not know
 * about — generate and migrate, never push.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.ANANSI_DB_PATH ?? "../../data/anansi.db" },
});
