import type { ExtensionHealth, SourceHealth } from "@anansi/db";

export type SourceSupport = "supported" | "experimental" | "coming_next";
export type SourceMode = "page" | "observe" | "manual";

export interface SourceDefinition {
	source: string;
	name: string;
	host: string;
	note: string;
	support: SourceSupport;
	mode: SourceMode;
	toggleable: boolean;
	requiresExtension: boolean;
}

export const SOURCE_CATALOG: readonly SourceDefinition[] = [
	{
		source: "x",
		name: "X bookmarks",
		host: "x.com",
		note: "Bookmarks captured live and through a resumable history import.",
		support: "supported",
		mode: "page",
		toggleable: true,
		requiresExtension: true,
	},
	{
		source: "reddit",
		name: "Reddit saves",
		host: "reddit.com",
		note: "Saved posts and comments captured live and through history import.",
		support: "supported",
		mode: "page",
		toggleable: true,
		requiresExtension: true,
	},
	{
		source: "tiktok",
		name: "TikTok favourites",
		host: "tiktok.com",
		note: "Favourite-list observation is implemented but still needs authenticated acceptance.",
		support: "experimental",
		mode: "observe",
		toggleable: true,
		requiresExtension: true,
	},
	{
		source: "web",
		name: "Web pages & bookmarks",
		host: "Any website",
		note: "Pages, selections, and optional Chrome bookmark mirroring.",
		support: "supported",
		mode: "manual",
		toggleable: false,
		requiresExtension: true,
	},
	{
		source: "github",
		name: "GitHub stars",
		host: "github.com",
		note: "Starred repositories captured live and through a resumable history import.",
		support: "supported",
		mode: "page",
		toggleable: true,
		requiresExtension: true,
	},
] as const;

const EMPTY_HEALTH = {
	items: 0,
	live: 0,
	imported: 0,
	toolbar: 0,
	contextMenu: 0,
	chromeBookmarks: 0,
	legacyUnknown: 0,
	authors: 0,
	lastCaptureAt: null,
	lastSavedAt: null,
	lastPostedAt: null,
	media: 0,
	mediaStored: 0,
};

export function sourceCatalogueResponse(
	health: SourceHealth[],
	disabled: string[],
	extension: ExtensionHealth,
) {
	const bySource = new Map(health.map((row) => [row.source, row]));
	const off = new Set(disabled);
	return {
		extension,
		sources: SOURCE_CATALOG.map((definition) => ({
			...definition,
			...EMPTY_HEALTH,
			...bySource.get(definition.source),
			enabled: definition.toggleable ? !off.has(definition.source) : true,
			runtime:
				extension.sources[
					definition.source as keyof typeof extension.sources
				] ?? null,
		})),
	};
}

export function isToggleableSource(source: string): boolean {
	return SOURCE_CATALOG.some(
		(entry) => entry.source === source && entry.toggleable,
	);
}
