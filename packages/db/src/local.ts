import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";
import { registerAtomicExecutor } from "./atomic.ts";

/**
 * The local driver. Kept in its own module so a Worker bundle never pulls
 * `bun:sqlite` in through a shared entry point.
 */
export function openLocalDb(path: string) {
  const directory = dirname(path);
  if (directory && directory !== ".") mkdirSync(directory, { recursive: true });
  const sqlite = new Database(path, { create: true });
  // Cascade deletes are declared in the schema and are inert without this.
  sqlite.exec("PRAGMA foreign_keys = ON");
  // The library is read far more than it is written; WAL suits that.
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  registerAtomicExecutor(db, async (build) => {
    db.transaction((transaction) => {
      for (const statement of build(transaction as unknown as typeof db)) {
        // Bun SQLite transactions are synchronous. Awaiting a thenable in an
        // async callback lets Drizzle commit before the callback resumes.
        statement.run();
      }
    });
  });
  return db;
}

export function migrateLocalDb(db: ReturnType<typeof openLocalDb>): void {
  const here = dirname(fileURLToPath(import.meta.url));
  migrate(db, { migrationsFolder: join(here, "..", "drizzle") });
}
