import type { Creator } from "./api.ts";

/**
 * The second line of an author tile, when it says something the first does not.
 *
 * Web authors are their domain, so "github.com" over "@github.com" would say
 * the same thing twice.
 */
export function authorHandleLine(creator: Pick<Creator, "authorHandle" | "authorName">): string | null {
	const handle = creator.authorHandle?.replace(/^@/, "").trim();
	if (!handle) return null;
	const name = creator.authorName?.trim();
	if (!name || name.toLowerCase() === handle.toLowerCase()) return null;
	return `@${handle}`;
}
