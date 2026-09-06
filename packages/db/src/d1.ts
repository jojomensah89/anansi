import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { AnansiDb } from "./types.ts";
import { registerAtomicExecutor } from "./atomic.ts";

// Workers Free permits 50 D1 queries per invocation. Leave room for the
// reads which prepare an atomic write instead of discovering the platform
// limit only after a user's capture has reached the server.
export const D1_ATOMIC_STATEMENT_LIMIT = 40;

/**
 * The other half of the driver seam.
 *
 * Kept in its own module for the same reason local.ts is: a Worker bundle must
 * never pull `bun:sqlite` in through a shared entry point, and the CLI must
 * never pull Cloudflare types in through one.
 *
 * Everything above this line — every query, every MCP tool — is unchanged
 * between the two. That was the whole point of AnansiDb being
 * BaseSQLiteDatabase rather than a concrete driver type, and this file is
 * where that decision either pays off or does not.
 */
export function openD1(binding: D1Database): AnansiDb {
  const db = drizzle(binding, { schema });
  registerAtomicExecutor(db as unknown as AnansiDb, async (build) => {
    const statements = build(db as unknown as AnansiDb);
    if (statements.length === 0) return;
    if (statements.length > D1_ATOMIC_STATEMENT_LIMIT) {
      throw new Error(
        `D1 atomic write exceeds the ${D1_ATOMIC_STATEMENT_LIMIT}-statement personal-tier limit`,
      );
    }
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  });
  return db as unknown as AnansiDb;
}
