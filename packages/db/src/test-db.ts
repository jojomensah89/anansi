import { migrateLocalDb, openLocalDb } from "./local.ts";

/** A fully migrated, isolated database for behavior tests. */
export function openTestDb() {
	const db = openLocalDb(":memory:");
	migrateLocalDb(db);
	return db;
}
