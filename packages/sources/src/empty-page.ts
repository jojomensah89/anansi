/**
 * Whether a history page is a recognized, genuinely empty end of the list.
 *
 * Every import run ends with one of these, and rejecting them counted a normal
 * ending as a failed capture. A page in a shape we do not recognize is not
 * empty: it may mean a provider changed its format, so it still fails loudly.
 */
export function isEmptyHistoryPage(source: string, raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	const page = raw as Record<string, any>;
	switch (source) {
		case "x": {
			const timeline = page.data?.bookmark_timeline_v2?.timeline ?? page.data?.bookmark_timeline?.timeline;
			if (!Array.isArray(timeline?.instructions)) return false;
			return timeline.instructions.every(
				(instruction: any) =>
					!Array.isArray(instruction?.entries) ||
					instruction.entries.every((entry: any) => String(entry?.entryId ?? "").startsWith("cursor-")),
			);
		}
		case "reddit":
			return Array.isArray(page.data?.children) && page.data.children.length === 0;
		case "tiktok":
			if (Array.isArray(page.itemList)) return page.itemList.length === 0;
			return page.itemList === undefined && page.statusCode === 0;
		case "github":
			return Array.isArray(page.repositories) && page.repositories.length === 0;
		default:
			return false;
	}
}
