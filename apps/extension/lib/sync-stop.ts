/** Shared bounded catch-up rule. Undefined known IDs means a history import. */
export function syncStopReason(
	ids: readonly string[],
	known: readonly string[] | undefined,
	page: number,
	cap = 10,
): "known" | "page_limit" | null {
	if (!known) return null;
	const snapshot = new Set(known);
	if (ids.some((id) => snapshot.has(id))) return "known";
	return page >= Math.max(1, Math.min(10, cap)) ? "page_limit" : null;
}
