import { sql, type SQL } from "drizzle-orm";
import {
	SOURCE_CAPABILITIES,
	VISIBLE_LIBRARY_SOURCES,
	type Source,
} from "@anansi/sources/capabilities";

/** Sources retained for repair but intentionally absent from the product UI. */
export const HIDDEN_SOURCES: readonly Source[] = SOURCE_CAPABILITIES.filter(
	({ productVisible }) => !productVisible,
).map(({ source }) => source);

export function isHiddenSource(source: string): boolean {
	return (HIDDEN_SOURCES as readonly string[]).includes(source);
}

/** Keep the database guard's membership visibly tied to the product view. */
export function isVisibleSource(source: string): boolean {
	return (VISIBLE_LIBRARY_SOURCES as readonly string[]).includes(source);
}

/** Bound SQL predicate used at every user-facing item query boundary. */
export function visibleSourceClause(column: SQL): SQL {
	return sql`${column} not in (${sql.join(HIDDEN_SOURCES.map((source) => sql`${source}`), sql`, `)})`;
}
