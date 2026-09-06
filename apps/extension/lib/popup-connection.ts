export const POPUP_SOURCES = ["x", "reddit", "github"] as const;

export interface PopupSourceConfig {
	source: string;
	host: string;
	mode: "page" | "observe";
	operation?: string;
	url?: string;
	variables?: Record<string, unknown>;
	cursorPrefix?: string;
	cursorParam?: string;
	cursorPath?: string;
	entryPrefix?: string;
	pageLimit?: number;
	watchOperations?: string[];
	watchUrls?: string[];
}

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

const OPTIONAL_STRINGS = [
	"operation",
	"url",
	"cursorPrefix",
	"cursorParam",
	"cursorPath",
	"entryPrefix",
] as const;

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

function isPopupSourceConfig(value: unknown): value is PopupSourceConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const row = value as Record<string, unknown>;
	if (!POPUP_SOURCES.includes(row.source as (typeof POPUP_SOURCES)[number]))
		return false;
	if (typeof row.host !== "string" || row.host.trim() === "") return false;
	if (row.mode !== "page" && row.mode !== "observe") return false;
	if (
		OPTIONAL_STRINGS.some(
			(key) => row[key] !== undefined && typeof row[key] !== "string",
		)
	)
		return false;
	if (
		row.variables !== undefined &&
		(typeof row.variables !== "object" ||
			row.variables === null ||
			Array.isArray(row.variables))
	)
		return false;
	if (
		row.pageLimit !== undefined &&
		(!Number.isInteger(row.pageLimit) || Number(row.pageLimit) <= 0)
	)
		return false;
	if (row.watchOperations !== undefined && !isStringArray(row.watchOperations))
		return false;
	if (row.watchUrls !== undefined && !isStringArray(row.watchUrls))
		return false;
	return true;
}

/** Reject the entire remote catalogue if one instruction is unsafe or ambiguous. */
export function validatePopupRemoteConfig(value: unknown): value is {
	readonly version: number;
	readonly enabled: boolean;
	readonly ingest: string;
	readonly sources: PopupSourceConfig[];
} {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const config = value as Record<string, unknown>;
	if (!Number.isInteger(config.version) || Number(config.version) < 1)
		return false;
	if (typeof config.enabled !== "boolean") return false;
	if (typeof config.ingest !== "string") return false;
	try {
		const ingest = new URL(config.ingest);
		if (ingest.protocol !== "https:" && ingest.protocol !== "http:")
			return false;
	} catch {
		return false;
	}
	const sources = config.sources;
	if (!Array.isArray(sources) || !sources.every(isPopupSourceConfig))
		return false;
	return new Set(sources.map((row) => row.source)).size === sources.length;
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
