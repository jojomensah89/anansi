import {
	EXTENSION_PLATFORM_SOURCES,
	SHIPPED_CAPTURE_SOURCES,
	sourceFlags,
	type ExtensionPlatformSource,
	type ShippedCaptureSource,
} from "./capabilities.ts";

/** The shape returned by `/api/extension/config` and consumed by the extension. */
export interface ExtensionSourceConfig {
	source: ExtensionPlatformSource;
	host: string;
	/**
	 * Extension wire execution mode, not the product catalogue's history
	 * import mode: page-driven operation or observer setup.
	 */
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

export interface ExtensionConfigFeatures {
	captureV2?: Partial<Record<ShippedCaptureSource, boolean>>;
	chromeBookmarks?: boolean;
}

export interface ExtensionRemoteConfig {
	version: number;
	enabled: boolean;
	ingest: string;
	ingestProtocolVersion?: number;
	features?: ExtensionConfigFeatures;
	sources: ExtensionSourceConfig[];
}

/** Compatibility aliases for callers that use the shorter wire names. */
export type RemoteConfig = ExtensionRemoteConfig;
export type SourceConfig = ExtensionSourceConfig;

export type ExtensionConfigValidationErrorCode =
	| "invalid_config"
	| "unsupported_version"
	| "unknown_source"
	| "duplicate_source"
	| "inconsistent_source";

export interface ExtensionConfigValidationError {
	code: ExtensionConfigValidationErrorCode;
	message: string;
}

export type ExtensionConfigParseResult =
	| { ok: true; config: ExtensionRemoteConfig }
	| { ok: false; error: ExtensionConfigValidationError };

const ROOT_KEYS = new Set([
	"version",
	"enabled",
	"ingest",
	"ingestProtocolVersion",
	"features",
	"sources",
]);
const FEATURE_KEYS = new Set(["captureV2", "chromeBookmarks"]);
const SOURCE_KEYS = new Set([
	"source",
	"host",
	"mode",
	"operation",
	"url",
	"variables",
	"cursorPrefix",
	"cursorParam",
	"cursorPath",
	"entryPrefix",
	"pageLimit",
	"watchOperations",
	"watchUrls",
]);
const OPTIONAL_STRINGS = [
	"operation",
	"url",
	"cursorPrefix",
	"cursorParam",
	"cursorPath",
	"entryPrefix",
] as const;
const CAPTURE_SOURCES = new Set<ShippedCaptureSource>(
	SHIPPED_CAPTURE_SOURCES,
);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function httpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

function fail(
	code: ExtensionConfigValidationErrorCode,
	message: string,
): ExtensionConfigParseResult {
	return { ok: false, error: { code, message } };
}

function validSourceConfig(value: unknown): value is ExtensionSourceConfig {
	if (!record(value) || !exactKeys(value, SOURCE_KEYS)) return false;
	if (!EXTENSION_PLATFORM_SOURCES.includes(value.source as ExtensionPlatformSource)) {
		return false;
	}
	if (typeof value.host !== "string" || value.host.trim() === "") return false;
	if (value.mode !== "page" && value.mode !== "observe") return false;
	if (
		OPTIONAL_STRINGS.some(
			(key) => value[key] !== undefined && typeof value[key] !== "string",
		)
	)
		return false;
	if (value.url !== undefined && !httpUrl(value.url as string)) return false;
	if (
		value.variables !== undefined &&
		(!record(value.variables) || value.variables === null)
	)
		return false;
	if (
		value.pageLimit !== undefined &&
		(typeof value.pageLimit !== "number" ||
			!Number.isInteger(value.pageLimit) ||
			value.pageLimit <= 0)
	)
		return false;
	if (value.watchOperations !== undefined && !stringArray(value.watchOperations))
		return false;
	if (value.watchUrls !== undefined && !stringArray(value.watchUrls)) return false;
	return true;
}

function validFeatures(value: unknown): value is ExtensionConfigFeatures {
	if (!record(value) || !exactKeys(value, FEATURE_KEYS)) return false;
	if (value.chromeBookmarks !== undefined && typeof value.chromeBookmarks !== "boolean")
		return false;
	if (value.captureV2 === undefined) return true;
	if (!record(value.captureV2)) return false;
	for (const [source, enabled] of Object.entries(value.captureV2)) {
		if (!CAPTURE_SOURCES.has(source as ShippedCaptureSource)) return false;
		if (typeof enabled !== "boolean") return false;
	}
	return true;
}

/** Strict validation for JSON crossing the server/background or popup seam. */
export function parseExtensionConfig(value: unknown): ExtensionConfigParseResult {
	if (!record(value) || !exactKeys(value, ROOT_KEYS))
		return fail("invalid_config", "extension config shape is invalid");
	if (
		typeof value.version !== "number" ||
		!Number.isInteger(value.version) ||
		value.version < 1
	)
		return fail("unsupported_version", "extension config version is unsupported");
	if (typeof value.enabled !== "boolean")
		return fail("invalid_config", "extension enabled flag is invalid");
	if (typeof value.ingest !== "string" || !httpUrl(value.ingest))
		return fail("invalid_config", "extension ingest URL is invalid");
	if (
		value.ingestProtocolVersion !== undefined &&
		(typeof value.ingestProtocolVersion !== "number" ||
			!Number.isInteger(value.ingestProtocolVersion) ||
			value.ingestProtocolVersion < 1)
	)
		return fail("invalid_config", "extension ingest protocol is invalid");
	if (value.features !== undefined && !validFeatures(value.features))
		return fail("invalid_config", "extension feature flags are invalid");
	if (!Array.isArray(value.sources))
		return fail("invalid_config", "extension source list is invalid");
	const seen = new Set<string>();
	for (const source of value.sources) {
		if (!record(source) || typeof source.source !== "string")
			return fail("invalid_config", "extension source instruction is invalid");
		if (!EXTENSION_PLATFORM_SOURCES.includes(source.source as ExtensionPlatformSource))
			return fail("unknown_source", "extension source is not shipped");
		if (seen.has(source.source))
			return fail("duplicate_source", "extension source list contains duplicates");
		if (!validSourceConfig(source))
			return fail("inconsistent_source", "extension source instruction is inconsistent");
		seen.add(source.source);
	}
	// A source feature can only be enabled for a capture source known to this
	// contract. TikTok is deliberately absent even though retained parsing knows
	// how to read its old payloads.
	return {
		ok: true,
		config: value as unknown as ExtensionRemoteConfig,
	};
}

/** Type-guard form used by popup code and tests. */
export function isExtensionRemoteConfig(
	value: unknown,
): value is ExtensionRemoteConfig {
	return parseExtensionConfig(value).ok;
}

/** Alias emphasizing that this is a wire validator, not a parser registry. */
export const validateExtensionConfig = isExtensionRemoteConfig;

/** Default feature flags used by the server response builder. */
export const SHIPPED_CAPTURE_FLAGS = sourceFlags(SHIPPED_CAPTURE_SOURCES);
