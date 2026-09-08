/**
 * Canonical source identity and the facts that are safe to share across
 * runtimes.
 *
 * This module deliberately contains no parser, browser, database, or server
 * imports. A source can be retained for parsing/storage without being part of
 * the current product or extension, so callers must choose a view instead of
 * treating one `supported` flag as the whole contract.
 */

export type CaptureMethod =
	| "platform_event"
	| "platform_import"
	| "toolbar"
	| "context_menu"
	| "chrome_bookmark";

export type ImportMode = "page" | "session";

type SourceCapabilityRecord = {
	readonly source: string;
	readonly retainedParsing: boolean;
	readonly productVisible: boolean;
	readonly extensionPlatform: boolean;
	readonly importMode: ImportMode | null;
	readonly liveCapture: boolean;
	readonly manualCapture: boolean;
	readonly toggleable: boolean;
	/** Capture methods currently permitted by the shipped product. */
	readonly captureMethods: readonly CaptureMethod[];
	/** Methods accepted by retained capture parsing, including paused sources. */
	readonly retainedCaptureMethods: readonly CaptureMethod[];
};

const PLATFORM_CAPTURE_METHODS = [
	"platform_event",
	"platform_import",
] as const satisfies readonly CaptureMethod[];
const MANUAL_CAPTURE_METHODS = [
	"toolbar",
	"context_menu",
	"chrome_bookmark",
] as const satisfies readonly CaptureMethod[];

/**
 * One row per source. The order is intentional: it preserves the current
 * visible catalogue order, with the retained-but-hidden TikTok identity last.
 */
export const SOURCE_CAPABILITIES = [
	{
		source: "x",
		retainedParsing: true,
		productVisible: true,
		extensionPlatform: true,
		importMode: "page",
		liveCapture: true,
		manualCapture: false,
		toggleable: true,
		captureMethods: PLATFORM_CAPTURE_METHODS,
		retainedCaptureMethods: PLATFORM_CAPTURE_METHODS,
	},
	{
		source: "reddit",
		retainedParsing: true,
		productVisible: true,
		extensionPlatform: true,
		importMode: "session",
		liveCapture: true,
		manualCapture: false,
		toggleable: true,
		captureMethods: PLATFORM_CAPTURE_METHODS,
		retainedCaptureMethods: PLATFORM_CAPTURE_METHODS,
	},
	{
		source: "web",
		retainedParsing: true,
		productVisible: true,
		extensionPlatform: false,
		importMode: null,
		liveCapture: false,
		manualCapture: true,
		toggleable: false,
		captureMethods: MANUAL_CAPTURE_METHODS,
		retainedCaptureMethods: MANUAL_CAPTURE_METHODS,
	},
	{
		source: "github",
		retainedParsing: true,
		productVisible: true,
		extensionPlatform: true,
		importMode: "session",
		liveCapture: true,
		manualCapture: false,
		toggleable: true,
		captureMethods: PLATFORM_CAPTURE_METHODS,
		retainedCaptureMethods: PLATFORM_CAPTURE_METHODS,
	},
	{
		source: "tiktok",
		retainedParsing: true,
		productVisible: false,
		extensionPlatform: false,
		importMode: null,
		liveCapture: false,
		manualCapture: false,
		toggleable: false,
		// TikTok remains parseable/storable, but is not shipped or currently
		// permitted to capture. Its old platform payloads stay accepted below.
		captureMethods: [],
		retainedCaptureMethods: PLATFORM_CAPTURE_METHODS,
	},
] as const satisfies readonly SourceCapabilityRecord[];

export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];
export type Source = SourceCapability["source"];
export type CaptureSource = Source;

/** Runtime identity list, derived from the canonical capability rows. */
export const SOURCE_IDS: readonly Source[] = SOURCE_CAPABILITIES.map(
	({ source }) => source,
);

type SourcesWith<K extends keyof SourceCapabilityRecord, V> = Extract<
	SourceCapability,
	{ readonly [P in K]: V }
>["source"];

function view<K extends keyof SourceCapabilityRecord, V extends SourceCapabilityRecord[K]>(
	key: K,
	value: V,
): readonly SourcesWith<K, V>[] {
	return SOURCE_CAPABILITIES.filter(
		(entry) => (entry[key] as unknown) === (value as unknown),
	).map((entry) => entry.source) as unknown as readonly SourcesWith<K, V>[];
}

/** Sources whose parser/storage contracts are intentionally retained. */
export const RETAINED_PARSING_SOURCES = view("retainedParsing", true);
/** Sources currently allowed to appear in user-facing library views. */
export const VISIBLE_LIBRARY_SOURCES = view("productVisible", true);
/** Platform sources with shipped extension content/background integration. */
export const EXTENSION_PLATFORM_SOURCES = view("extensionPlatform", true);
/** Sources whose history import is driven by an in-page adapter. */
export const PAGE_IMPORT_SOURCES = view("importMode", "page");
/** Sources whose history import is driven by background session requests. */
export const SESSION_IMPORT_SOURCES = view("importMode", "session");
/** Sources with current live platform-event capture. */
export const LIVE_CAPTURE_SOURCES = view("liveCapture", true);
/** Sources with current deliberate/manual capture. */
export const MANUAL_CAPTURE_SOURCES = view("manualCapture", true);
/** Sources whose current product toggle is persisted server-side. */
export const TOGGLEABLE_SOURCES = view("toggleable", true);

/** All currently shipped capture sources, including manual Web capture. */
export const SHIPPED_CAPTURE_SOURCES = [
	...EXTENSION_PLATFORM_SOURCES,
	...MANUAL_CAPTURE_SOURCES,
] as const satisfies readonly Source[];

// Short aliases for callers that need the view names from the architecture
// guide without losing the more descriptive exported names above.
export const RETAINED_SOURCES = RETAINED_PARSING_SOURCES;
export const VISIBLE_SOURCES = VISIBLE_LIBRARY_SOURCES;
export const EXTENSION_SOURCES = EXTENSION_PLATFORM_SOURCES;

export type RetainedParsingSource = (typeof RETAINED_PARSING_SOURCES)[number];
export type VisibleLibrarySource = (typeof VISIBLE_LIBRARY_SOURCES)[number];
export type ExtensionPlatformSource =
	(typeof EXTENSION_PLATFORM_SOURCES)[number];
export type PageImportSource = (typeof PAGE_IMPORT_SOURCES)[number];
export type SessionImportSource = (typeof SESSION_IMPORT_SOURCES)[number];
export type LiveCaptureSource = (typeof LIVE_CAPTURE_SOURCES)[number];
export type ManualCaptureSource = (typeof MANUAL_CAPTURE_SOURCES)[number];
export type ToggleableSource = (typeof TOGGLEABLE_SOURCES)[number];
export type ShippedCaptureSource = (typeof SHIPPED_CAPTURE_SOURCES)[number];

const SOURCE_BY_ID = new Map<Source, SourceCapability>(
	SOURCE_CAPABILITIES.map((entry) => [entry.source, entry]),
);

export function isSource(value: unknown): value is Source {
	return typeof value === "string" && SOURCE_BY_ID.has(value as Source);
}

export const isKnownSource = isSource;

export function sourceCapability(value: unknown): SourceCapability | null {
	return isSource(value) ? SOURCE_BY_ID.get(value) ?? null : null;
}

export function isExtensionPlatformSource(
	value: unknown,
): value is ExtensionPlatformSource {
	return sourceCapability(value)?.extensionPlatform === true;
}

export function isRetainedParsingSource(
	value: unknown,
): value is RetainedParsingSource {
	return sourceCapability(value)?.retainedParsing === true;
}

export function isPageImportSource(value: unknown): value is PageImportSource {
	return sourceCapability(value)?.importMode === "page";
}

export function isSessionImportSource(
	value: unknown,
): value is SessionImportSource {
	return sourceCapability(value)?.importMode === "session";
}

export function isManualCaptureSource(
	value: unknown,
): value is ManualCaptureSource {
	return sourceCapability(value)?.manualCapture === true;
}

export function isLiveCaptureSource(value: unknown): value is LiveCaptureSource {
	return sourceCapability(value)?.liveCapture === true;
}

export function isToggleableSource(value: unknown): value is ToggleableSource {
	return sourceCapability(value)?.toggleable === true;
}

/** Current capture methods, intentionally empty for paused/retained TikTok. */
export function captureMethodsForSource(
	value: unknown,
): readonly CaptureMethod[] {
	return sourceCapability(value)?.captureMethods ?? [];
}

/** Methods accepted by retained parsing/storage contracts. */
export function retainedCaptureMethodsForSource(
	value: unknown,
): readonly CaptureMethod[] {
	return sourceCapability(value)?.retainedCaptureMethods ?? [];
}

export function supportsCaptureMethod(
	source: unknown,
	method: unknown,
): method is CaptureMethod {
	return typeof method === "string" &&
		captureMethodsForSource(source).includes(method as CaptureMethod);
}

export function supportsRetainedCaptureMethod(
	source: unknown,
	method: unknown,
): method is CaptureMethod {
	return typeof method === "string" &&
		retainedCaptureMethodsForSource(source).includes(method as CaptureMethod);
}

/**
 * Build a boolean feature map from a capability view. The generic keeps this
 * useful for the extension's capture flags without importing its config type.
 */
export function sourceFlags<S extends Source>(
	sources: readonly S[],
): Partial<Record<S, boolean>> {
	return Object.fromEntries(sources.map((source) => [source, true])) as Partial<
		Record<S, boolean>
	>;
}

export type CapabilityFactsValidationError =
	| { code: "invalid_shape"; source?: string }
	| { code: "duplicate_source"; source: string }
	| { code: "inconsistent_facts"; source: string };

export type CapabilityFactsValidationResult =
	| { ok: true }
	| { ok: false; error: CapabilityFactsValidationError };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethod(methods: readonly unknown[], method: CaptureMethod): boolean {
	return methods.includes(method);
}

const ALL_CAPTURE_METHODS = [
	...PLATFORM_CAPTURE_METHODS,
	...MANUAL_CAPTURE_METHODS,
] as const satisfies readonly CaptureMethod[];

function hasAnyMethod(
	methods: readonly unknown[],
	candidates: readonly CaptureMethod[],
): boolean {
	return candidates.some((method) => hasMethod(methods, method));
}

/** Validate facts before a future source row can become a new shared view. */
export function validateSourceCapabilityFacts(
	value: unknown,
): CapabilityFactsValidationResult {
	if (!Array.isArray(value)) {
		return { ok: false, error: { code: "invalid_shape" } };
	}
	const seen = new Set<string>();
	for (const candidate of value) {
		if (!isPlainRecord(candidate) || typeof candidate.source !== "string") {
			return { ok: false, error: { code: "invalid_shape" } };
		}
		if (!isSource(candidate.source)) {
			return {
				ok: false,
				error: { code: "invalid_shape", source: candidate.source },
			};
		}
		if (seen.has(candidate.source)) {
			return {
				ok: false,
				error: { code: "duplicate_source", source: candidate.source },
			};
		}
		seen.add(candidate.source);
		if (
			typeof candidate.retainedParsing !== "boolean" ||
			typeof candidate.productVisible !== "boolean" ||
			typeof candidate.extensionPlatform !== "boolean" ||
			(candidate.importMode !== null &&
				candidate.importMode !== "page" &&
				candidate.importMode !== "session") ||
			typeof candidate.liveCapture !== "boolean" ||
			typeof candidate.manualCapture !== "boolean" ||
			typeof candidate.toggleable !== "boolean" ||
			!Array.isArray(candidate.captureMethods) ||
			!Array.isArray(candidate.retainedCaptureMethods)
		) {
			return {
				ok: false,
				error: { code: "invalid_shape", source: candidate.source },
			};
		}
		const methods = candidate.captureMethods;
		const retainedMethods = candidate.retainedCaptureMethods;
		if (
			!methods.every((method) =>
				ALL_CAPTURE_METHODS.includes(method as CaptureMethod),
			) ||
			!retainedMethods.every((method) =>
				ALL_CAPTURE_METHODS.includes(method as CaptureMethod),
			)
		) {
			return {
				ok: false,
				error: { code: "invalid_shape", source: candidate.source },
			};
		}
		const productVisible = candidate.productVisible;
		const extensionPlatform = candidate.extensionPlatform;
		const importMode = candidate.importMode;
		const liveCapture = candidate.liveCapture;
		const manualCapture = candidate.manualCapture;
		const toggleable = candidate.toggleable;
		const hasPlatformEvent = hasMethod(methods, "platform_event");
		const hasPlatformImport = hasMethod(methods, "platform_import");
		const hasManualMethod = hasAnyMethod(methods, MANUAL_CAPTURE_METHODS);
		const hasPlatformMethod = hasPlatformEvent || hasPlatformImport;
		if (
			!candidate.retainedParsing ||
			(productVisible && !candidate.retainedParsing) ||
			(extensionPlatform && !productVisible) ||
			(importMode !== null && !extensionPlatform) ||
			// Live capture and platform events are two sides of one fact. A
			// retained parser may still know an old platform event, but it must
			// live in retainedCaptureMethods rather than current captureMethods.
			(liveCapture !== hasPlatformEvent) ||
			(hasPlatformEvent && !extensionPlatform) ||
			// Manual capture methods likewise cannot be advertised while the
			// manual fact is false, or combined with a platform source.
			(manualCapture !== hasManualMethod) ||
			(manualCapture && (extensionPlatform || importMode !== null)) ||
			(manualCapture && liveCapture) ||
			(hasPlatformImport !== (importMode !== null)) ||
			(hasPlatformMethod && hasManualMethod) ||
			(extensionPlatform && !hasPlatformMethod) ||
			(toggleable && (!productVisible || !extensionPlatform)) ||
			(productVisible && methods.length === 0) ||
			(!productVisible && methods.length > 0) ||
			!methods.every((method) => retainedMethods.includes(method)) ||
			(!candidate.retainedParsing && retainedMethods.length > 0)
		) {
			return {
				ok: false,
				error: { code: "inconsistent_facts", source: candidate.source },
			};
		}
	}
	return { ok: true };
}
