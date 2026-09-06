import { sql, type SQL } from "drizzle-orm";

/** Sources retained for repair but intentionally absent from the product UI. */
export const HIDDEN_SOURCES = ["tiktok"] as const;

export function isHiddenSource(source: string): boolean {
	return (HIDDEN_SOURCES as readonly string[]).includes(source);
}

/** Bound SQL predicate used at every user-facing item query boundary. */
export function visibleSourceClause(column: SQL): SQL {
	return sql`${column} not in (${sql.join(HIDDEN_SOURCES.map((source) => sql`${source}`), sql`, `)})`;
}
