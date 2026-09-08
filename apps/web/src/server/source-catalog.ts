import type { ExtensionHealth, SourceHealth } from "@anansi/db";
import {
	VISIBLE_LIBRARY_SOURCES,
	isToggleableSource as isCapabilityToggleableSource,
	sourceCapability,
	type ImportMode,
	type ToggleableSource,
	type VisibleLibrarySource,
} from "@anansi/sources";

export type SourceSupport = "supported" | "experimental" | "coming_next";
/**
 * Product catalogue capture mode. This describes how history enters Anansi;
 * it is deliberately different from ExtensionSourceConfig.mode, whose wire
 * values `page` and `observe` select extension execution behavior.
 */
export type SourceMode = ImportMode | "manual";

export interface SourceDefinition {
	source: VisibleLibrarySource;
	name: string;
	host: string;
	note: string;
	support: SourceSupport;
	mode: SourceMode;
	toggleable: boolean;
	requiresExtension: boolean;
}

type SourcePresentation = Omit<SourceDefinition, "source" | "mode">;

/** Display metadata stays web-owned; membership comes from the shared view. */
const SOURCE_PRESENTATION: Record<VisibleLibrarySource, SourcePresentation> = {
	x: {
		name: "X bookmarks",
		host: "x.com",
		note: "Bookmarks captured live and through a resumable history import.",
		support: "supported",
		toggleable: true,
		requiresExtension: true,
	},
	reddit: {
		name: "Reddit saves",
		host: "reddit.com",
		note: "Saved posts and comments captured live and through history import.",
		support: "supported",
		toggleable: true,
		requiresExtension: true,
	},
	web: {
		name: "Web pages & bookmarks",
		host: "Any website",
		note: "Pages, selections, and optional Chrome bookmark mirroring.",
		support: "supported",
		toggleable: false,
		requiresExtension: true,
	},
	github: {
		name: "GitHub stars",
		host: "github.com",
		note: "Starred repositories captured live and through a resumable history import.",
		support: "supported",
		toggleable: true,
		requiresExtension: true,
	},
};

function productModeFor(source: VisibleLibrarySource): SourceMode {
	const capability = sourceCapability(source);
	if (!capability) throw new Error(`missing capabilities for visible source ${source}`);
	if (capability.manualCapture) return "manual";
	if (capability.importMode !== null) return capability.importMode;
	throw new Error(`visible source ${source} has no product capture mode`);
}

export const SOURCE_CATALOG: readonly SourceDefinition[] =
	VISIBLE_LIBRARY_SOURCES.map((source) => ({
		source,
		mode: productModeFor(source),
		...SOURCE_PRESENTATION[source],
	}));

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
			runtime: extension.sources[definition.source] ?? null,
		})),
	};
}

export function isToggleableSource(source: string): source is ToggleableSource {
	return isCapabilityToggleableSource(source);
}
