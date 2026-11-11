import {
	EXTENSION_PLATFORM_SOURCES,
	isToggleableSource,
	parseExtensionConfig,
	type ExtensionRemoteConfig,
	type ExtensionSourceConfig,
} from "@anansi/sources";

/** Sources with a shipped platform importer; Web is manual page capture. */
export const POPUP_SOURCES = EXTENSION_PLATFORM_SOURCES;

export type PopupSourceConfig = ExtensionSourceConfig;

export type PopupSourceRow = PopupSourceConfig & {
	enabled: boolean;
	configured: boolean;
	/** Has a capture switch. Web, saved by hand, is always on. */
	toggleable: boolean;
};

const FALLBACKS: Record<(typeof POPUP_SOURCES)[number], PopupSourceConfig> = {
	x: { source: "x", host: "x.com", mode: "page" },
	reddit: { source: "reddit", host: "reddit.com", mode: "page" },
	github: {
		source: "github",
		host: "github.com",
		mode: "page",
		url: "https://github.com/stars",
	},
	tiktok: { source: "tiktok", host: "tiktok.com", mode: "observe" },
};

/** Reject the entire remote catalogue if one instruction is unsafe or ambiguous. */
export function validatePopupRemoteConfig(
	value: unknown,
): value is ExtensionRemoteConfig {
	return parseExtensionConfig(value).ok;
}

/**
 * Keep the product catalogue visible even when remote instructions fail.
 *
 * Without a live config, `lastKnown` (the sources of the last config this
 * install accepted) says which were on, so a switch can show where it was
 * left. With neither, every source reads as on: that is the server default.
 */
export function popupSourceRows(
	remote: readonly PopupSourceConfig[] | null,
	lastKnown: readonly PopupSourceConfig[] | null = null,
): PopupSourceRow[] {
	const bySource = new Map(remote?.map((row) => [row.source, row]));
	const known = lastKnown ? new Set(lastKnown.map((row) => row.source)) : null;
	return POPUP_SOURCES.map((source) => {
		const configured = bySource.get(source);
		return configured
			? { ...configured, enabled: true, configured: true, toggleable: isToggleableSource(source) }
			: {
					...FALLBACKS[source],
					enabled: remote === null && (known === null || known.has(source)),
					configured: false,
					toggleable: isToggleableSource(source),
				};
	});
}

export type PopupConnectionKind =
	| "loading"
	| "connected"
	| "unreachable"
	| "unauthorized"
	| "incompatible"
	| "unconfigured";

export interface PopupConnectionState {
	kind: PopupConnectionKind;
	message: string;
}

export function connectionFromStatus(status: number): PopupConnectionState {
	if (status === 401 || status === 403) {
		return {
			kind: "unauthorized",
			message: "Credential mismatch — rebuild with the deployed ingest token",
		};
	}
	if (status === 404) {
		return {
			kind: "incompatible",
			message: "Incompatible server — update or redeploy Anansi",
		};
	}
	return {
		kind: "unreachable",
		message: `Server returned HTTP ${status}`,
	};
}

export const LOADING_CONNECTION: PopupConnectionState = {
	kind: "loading",
	message: "Connecting…",
};

export const CONNECTED_CONNECTION: PopupConnectionState = {
	kind: "connected",
	message: "Connected",
};

export const UNREACHABLE_CONNECTION: PopupConnectionState = {
	kind: "unreachable",
	message: "Server unreachable",
};

export const UNCONFIGURED_CONNECTION: PopupConnectionState = {
	kind: "unconfigured",
	message: "Not connected",
};
