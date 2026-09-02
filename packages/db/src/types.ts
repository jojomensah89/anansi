import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema.ts";
import type { items } from "./schema.ts";

/**
 * The seam the build spec asks for: everything reads and writes through one
 * module taking a driver — bun:sqlite locally, the D1 binding in production —
 * and nothing above this line knows which it got. That is what keeps day 8 a
 * change of build target rather than a rewrite of every query.
 *
 * Deliberately NOT a union of BunSQLiteDatabase | DrizzleD1Database. A union
 * makes every query method an unresolvable overload set, and the errors point
 * at the call sites rather than the cause. BaseSQLiteDatabase is Drizzle's own
 * driver-agnostic base; `"sync" | "async"` covers bun:sqlite's synchronous
 * results and D1's promises in one type.
 */
export type AnansiDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export type DbItem = typeof items.$inferSelect;
export type NewDbItem = typeof items.$inferInsert;
