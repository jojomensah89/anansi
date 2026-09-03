import type { NormalizedItem } from "./item.ts";

export const CAPTURE_SCHEMA_VERSION = 1 as const;

export type CaptureSource = "x" | "reddit" | "tiktok" | "web";
export type CaptureMethod =
	| "platform_event"
	| "platform_import"
	| "toolbar"
	| "context_menu"
	| "chrome_bookmark";
export type CaptureOutcome =
	| "created"
	| "updated"
	| "duplicate"
	| "ignored_stale";
export type CaptureQueueState =
	| "queued"
	| "uploading"
	| "retry_wait"
	| "failed";

export interface CaptureBase {
	schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
	eventId: string;
	source: CaptureSource;
	observedAt: number;
	captureMethod: CaptureMethod;
}

export interface RawPageCapture extends CaptureBase {
	payloadType: "raw_page";
	action: "snapshot";
	runId: string;
	page: number;
	cursor?: string;
	raw: unknown;
	rawPayloadVersion?: string;
}

export interface ItemEventCapture extends CaptureBase {
	payloadType: "item_event";
	action: "save" | "unsave";
	externalId: string;
	canonicalUrl: string;
	normalizedItem?: NormalizedItem;
	rawPayloadVersion?: string;
	sourceLink?: {
		kind: "chrome_bookmark";
		externalId: string;
	};
}

export type BookmarkCapture = RawPageCapture | ItemEventCapture;

export interface CaptureReceipt {
	eventId: string;
	itemId: string | null;
	outcome: CaptureOutcome;
	parsed?: number;
}

export interface CaptureQueueStatus {
	queued: number;
	uploading: number;
	retrying: number;
	failed: number;
}

export interface CaptureLimits {
	maxPayloadBytes?: number;
	maxStringLength?: number;
	maxObjectNodes?: number;
}

export interface CaptureValidationError {
	code:
		| "invalid_capture"
		| "unsupported_version"
		| "payload_too_large"
		| "sensitive_field";
	message: string;
}

export type CaptureParseResult =
	| { ok: true; capture: BookmarkCapture }
	| { ok: false; error: CaptureValidationError };

const DEFAULT_LIMITS = {
	maxPayloadBytes: 2_000_000,
	maxStringLength: 20_000,
	maxObjectNodes: 50_000,
};

const CAPTURE_SOURCES = new Set<CaptureSource>([
	"x",
	"reddit",
	"tiktok",
	"web",
]);
const PLATFORM_METHODS = new Set<CaptureMethod>([
	"platform_event",
	"platform_import",
]);
const WEB_METHODS = new Set<CaptureMethod>([
	"toolbar",
	"context_menu",
	"chrome_bookmark",
]);
const CAPTURE_METHODS = new Set<CaptureMethod>([
	...PLATFORM_METHODS,
	...WEB_METHODS,
]);
const ITEM_ACTIONS = new Set(["save", "unsave"]);
const ITEM_KINDS = new Set(["post", "repo", "comment", "video", "article"]);
const MEDIA_KINDS = new Set(["image", "video_poster", "card"]);
const SENSITIVE_KEYS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-csrf-token",
	"x-xsrf-token",
	"csrf-token",
	"csrftoken",
	"ct0",
	"password",
	"passwd",
]);

function fail(
	code: CaptureValidationError["code"],
	message: string,
): CaptureParseResult {
	return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
	value: unknown,
	max: number,
	allowEmpty = false,
): value is string {
	return (
		typeof value === "string" &&
		value.length <= max &&
		(allowEmpty || value.trim().length > 0)
	);
}

function isUnixSeconds(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		Number(value) > 0 &&
		Number(value) <= 10_000_000_000
	);
}

function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
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

function serializedBytes(value: unknown): number | null {
	try {
		const json = JSON.stringify(value);
		return json === undefined
			? null
			: new TextEncoder().encode(json).byteLength;
	} catch {
		return null;
	}
}

type ObjectInspection = "ok" | "sensitive" | "too_large";

function inspectObject(value: unknown, maxNodes: number): ObjectInspection {
	const pending: unknown[] = [value];
	const seen = new Set<object>();
	let visited = 0;

	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current !== "object" || current === null) continue;
		if (seen.has(current)) continue;
		seen.add(current);
		visited++;
		if (visited > maxNodes) return "too_large";

		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}

		for (const [key, child] of Object.entries(current)) {
			if (SENSITIVE_KEYS.has(key.toLowerCase())) return "sensitive";
			pending.push(child);
		}
	}

	return "ok";
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
	return value === undefined || isBoundedString(value, max, true);
}

function isOptionalPositiveNumber(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isFinite(value) && value > 0)
	);
}

function validNormalizedItem(
	value: unknown,
	source: CaptureSource,
	externalId: string,
	maxStringLength: number,
): value is NormalizedItem {
	if (!isRecord(value)) return false;
	if (value.source !== source || value.externalId !== externalId) return false;
	if (!isHttpUrl(value.url) || !ITEM_KINDS.has(value.kind as string))
		return false;
	if (!isBoundedString(value.body, maxStringLength, true)) return false;
	for (const field of [
		"authorHandle",
		"authorName",
		"authorAvatar",
		"title",
		"lang",
	] as const) {
		if (!isOptionalBoundedString(value[field], maxStringLength)) return false;
	}
	if (value.postedAt !== undefined && !isUnixSeconds(value.postedAt))
		return false;
	if (
		!isUnixSeconds(value.savedAt) ||
		typeof value.savedAtIsExact !== "boolean"
	)
		return false;
	if (
		value.saveOrder !== undefined &&
		(typeof value.saveOrder !== "number" || !Number.isFinite(value.saveOrder))
	) {
		return false;
	}
	if (
		!isRecord(value.metrics) ||
		!Array.isArray(value.media) ||
		!Array.isArray(value.links)
	) {
		return false;
	}
	if (
		!Object.values(value.metrics).every(
			(metric) => typeof metric === "number" && Number.isFinite(metric),
		)
	) {
		return false;
	}
	if (!value.links.every(isHttpUrl)) return false;
	if (
		!value.media.every(
			(entry) =>
				isRecord(entry) &&
				MEDIA_KINDS.has(entry.kind as string) &&
				isHttpUrl(entry.originUrl) &&
				isOptionalPositiveNumber(entry.width) &&
				isOptionalPositiveNumber(entry.height),
		)
	) {
		return false;
	}
	if (!Object.hasOwn(value, "raw")) return false;
	return true;
}

/**
 * Validate data crossing the page/extension/server seam without reflecting
 * attacker-controlled values in errors. Database-dependent rules, such as
 * whether a content-less save already exists, belong to capture application.
 */
export function parseBookmarkCapture(
	value: unknown,
	limits: CaptureLimits = {},
): CaptureParseResult {
	const maxPayloadBytes =
		limits.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes;
	const maxStringLength =
		limits.maxStringLength ?? DEFAULT_LIMITS.maxStringLength;
	const maxObjectNodes = limits.maxObjectNodes ?? DEFAULT_LIMITS.maxObjectNodes;

	const bytes = serializedBytes(value);
	if (bytes === null)
		return fail("invalid_capture", "capture must be serializable JSON");
	if (bytes > maxPayloadBytes) {
		return fail(
			"payload_too_large",
			"capture exceeds the configured size limit",
		);
	}
	const inspection = inspectObject(value, maxObjectNodes);
	if (inspection === "too_large") {
		return fail(
			"payload_too_large",
			"capture exceeds the configured complexity limit",
		);
	}
	if (inspection === "sensitive") {
		return fail(
			"sensitive_field",
			"capture contains a forbidden credential field",
		);
	}
	if (!isRecord(value))
		return fail("invalid_capture", "capture must be an object");
	if (value.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
		return fail(
			"unsupported_version",
			"capture schema version is not supported",
		);
	}
	if (!isBoundedString(value.eventId, 200)) {
		return fail("invalid_capture", "capture event id is invalid");
	}
	if (!CAPTURE_SOURCES.has(value.source as CaptureSource)) {
		return fail("invalid_capture", "capture source is invalid");
	}
	if (!isUnixSeconds(value.observedAt)) {
		return fail("invalid_capture", "capture timestamp is invalid");
	}
	if (!CAPTURE_METHODS.has(value.captureMethod as CaptureMethod)) {
		return fail("invalid_capture", "capture method is invalid");
	}

	const source = value.source as CaptureSource;
	const method = value.captureMethod as CaptureMethod;
	if (
		(source === "web" && !WEB_METHODS.has(method)) ||
		(source !== "web" && !PLATFORM_METHODS.has(method))
	) {
		return fail("invalid_capture", "capture method does not match its source");
	}

	if (value.payloadType === "raw_page") {
		if (
			source === "web" ||
			value.action !== "snapshot" ||
			!PLATFORM_METHODS.has(method)
		) {
			return fail("invalid_capture", "raw-page capture metadata is invalid");
		}
		if (!isBoundedString(value.runId, 200)) {
			return fail("invalid_capture", "raw-page run id is invalid");
		}
		if (!Number.isSafeInteger(value.page) || Number(value.page) < 1) {
			return fail("invalid_capture", "raw-page number is invalid");
		}
		if (
			value.cursor !== undefined &&
			!isBoundedString(value.cursor, 10_000, true)
		) {
			return fail("invalid_capture", "raw-page cursor is invalid");
		}
		if (!Object.hasOwn(value, "raw")) {
			return fail("invalid_capture", "raw-page payload is missing");
		}
		if (!isOptionalBoundedString(value.rawPayloadVersion, 200)) {
			return fail("invalid_capture", "raw payload version is invalid");
		}
		return { ok: true, capture: value as unknown as RawPageCapture };
	}

	if (
		value.payloadType !== "item_event" ||
		!ITEM_ACTIONS.has(value.action as string)
	) {
		return fail("invalid_capture", "item-event metadata is invalid");
	}
	if (
		!isBoundedString(value.externalId, 1_000) ||
		!isBoundedString(value.canonicalUrl, 10_000) ||
		!isHttpUrl(value.canonicalUrl)
	) {
		return fail("invalid_capture", "item-event identity is invalid");
	}
	if (
		value.normalizedItem !== undefined &&
		!validNormalizedItem(
			value.normalizedItem,
			source,
			value.externalId,
			maxStringLength,
		)
	) {
		return fail("invalid_capture", "normalized item is invalid");
	}
	if (!isOptionalBoundedString(value.rawPayloadVersion, 200)) {
		return fail("invalid_capture", "raw payload version is invalid");
	}
	if (method === "chrome_bookmark" && value.sourceLink === undefined) {
		return fail("invalid_capture", "Chrome bookmark source link is required");
	}
	if (value.sourceLink !== undefined) {
		if (
			source !== "web" ||
			method !== "chrome_bookmark" ||
			!isRecord(value.sourceLink) ||
			value.sourceLink.kind !== "chrome_bookmark" ||
			!isBoundedString(value.sourceLink.externalId, 1_000)
		) {
			return fail("invalid_capture", "source link is invalid");
		}
	}

	return { ok: true, capture: value as unknown as ItemEventCapture };
}
