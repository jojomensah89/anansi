import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { dataPath } from "./files.ts";

/**
 * One place that decides where the library lives, so no command has to.
 *
 * `anansi.db` sits beside the raw pages under the data directory: the whole
 * library is one folder you can copy, back up, or delete.
 */
export function dbPath(): string {
  return process.env.ANANSI_DB_PATH ?? dataPath("anansi.db");
}

let handle: AnansiDb | undefined;

export function db(): AnansiDb {
  handle ??= openLocalDb(dbPath()) as AnansiDb;
  return handle;
}

/** Migrations are cheap and idempotent; run them rather than asking. */
export function ensureMigrated(): void {
  migrateLocalDb(openLocalDb(dbPath()));
}
