import { defineConfig } from "drizzle-kit";

/**
 * Local development only. Production is D1, applied with `wrangler d1
 * migrations apply` against the same SQL in ./drizzle.
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
