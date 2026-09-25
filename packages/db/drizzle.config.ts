import { defineConfig } from "drizzle-kit";

/**
 * Local development only. The configured database path is SQLite. Hosted D1
 * hosted D1 migrations are applied by Wrangler from this canonical SQL
 * directory. Do not use `db:push`: the FTS5 table and triggers require the
 * migration path.
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
