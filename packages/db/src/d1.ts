import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { AnansiDb } from "./types.ts";

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
  return drizzle(binding, { schema }) as unknown as AnansiDb;
}
