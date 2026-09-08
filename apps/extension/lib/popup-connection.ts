import {
	EXTENSION_PLATFORM_SOURCES,
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
};

/** Reject the entire remote catalogue if one instruction is unsafe or ambiguous. */
export function validatePopupRemoteConfig(
	value: unknown,
): value is ExtensionRemoteConfig {
	return parseExtensionConfig(value).ok;
}

/** Keep the product catalogue visible even when remote instructions fail. */
export function popupSourceRows(
	remote: readonly PopupSourceConfig[] | null,
): PopupSourceRow[] {
	const bySource = new Map(remote?.map((row) => [row.source, row]));
	return POPUP_SOURCES.map((source) => {
		const configured = bySource.get(source);
		return configured
			? { ...configured, enabled: true, configured: true }
			: {
					...FALLBACKS[source],
					enabled: remote === null,
					configured: false,
				};
	});
}

export type PopupConnectionKind =
	| "loading"
	| "connected"
	| "unreachable"
	| "unauthorized"
	| "incompatible";

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
