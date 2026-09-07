/**
 * Pure validation for the extension's three message directions.
 *
 * The caller supplies trusted delivery context (the current page URL, runtime
 * sender kind, and the nonce established for that tab). The effective source
 * is always derived from that context; a payload's source is only a claim that
 * must match it.
 *
 * A nonce visible to MAIN-world code prevents accidental cross-talk, but it is
 * not authentication against malicious code already executing in that page.
 */

export const MESSAGE_PROTOCOL_VERSION = 1 as const;

export type PlatformSource = "x" | "reddit" | "github";
export type MessagePath =
	| "page-to-relay"
	| "runtime-to-background"
	| "relay-to-page";

export type MessageContext =
	| {
			path: "page-to-relay" | "relay-to-page";
			pageUrl: string;
			expectedNonce: string;
	  }
	| {
			path: "runtime-to-background";
			sender: { kind: "extension" };
	  }
	| {
			path: "runtime-to-background";
			sender: { kind: "tab"; url: string };
			expectedNonce: string;
	  };

export interface MessageLimits {
	maxPayloadBytes?: number;
	maxNodes?: number;
	maxDepth?: number;
	maxKeysPerObject?: number;
	maxArrayLength?: number;
	maxStringLength?: number;
}

export interface MessageValidationError {
	code:
		| "invalid_message"
		| "unsupported_version"
		| "origin_not_allowed"
		| "source_mismatch"
		| "direction_mismatch"
		| "nonce_mismatch"
		| "payload_too_large"
		| "payload_too_complex"
		| "sensitive_field";
	message: string;
}

interface MessageBase {
	messageVersion: typeof MESSAGE_PROTOCOL_VERSION;
}

interface PageTrafficBase extends MessageBase {
	source: PlatformSource;
	nonce: string;
}

export type PageEventMessage = PageTrafficBase &
	(
		| { anansi: "page-event"; action: "ready"; queryId: string | null }
		| { anansi: "page-event"; action: "saved" }
		| {
				anansi: "page-event";
				action: "page";
				runId?: string;
				raw: unknown;
				page: number;
				items: number;
				/** Where the next page starts, once this one is durable. */
				cursor?: string;
		  }
		| {
				anansi: "page-event";
				action: "observed";
				operation: string;
				raw: unknown;
				items: number;
		  }
		| {
				anansi: "page-event";
				action: "bookmark";
				bookmarkAction: "save" | "unsave";
				externalId: string;
				/** Only ever a link on the platform the message came from. */
				canonicalUrl?: string;
				/** The object itself, when the page could look it up. */
				raw?: unknown;
		  }
		| {
				anansi: "page-event";
				action: "done";
				runId?: string;
				pages: number;
				items: number;
				state?: "complete" | "limited" | "cancelled";
			}
		| { anansi: "page-event"; action: "scanned" }
		| { anansi: "page-event"; action: "identified"; handle: string }
		| {
				anansi: "page-event";
				action: "error";
				runId?: string;
				errorCode:
					| "platform_request_failed"
					| "not_signed_in"
					| "query_unavailable"
					| "capture_failed"
					| "page_shape_changed"
					| "rate_limited";
		  }
	);

export type PopupCommandMessage = MessageBase &
	(
		| {
				anansi: "popup-command";
				action:
					| "queue-status"
					| "reschedule"
					| "save-page"
					| "mirror-status"
					| "mirror-on"
					| "mirror-off";
		  }
		| {
				anansi: "popup-command";
				action: "retry-queue";
				/** Narrow a retry to the row it was pressed on. */
				source?: PlatformSource;
		  }
		| {
				anansi: "popup-command";
				action: "start" | "stop";
				source: PlatformSource;
		  }
	);

export type PageCommandMessage = PageTrafficBase & {
	anansi: "page-command";
	action: "configure" | "backfill" | "identify" | "scan";
	runId?: string;
	config: Record<string, unknown>;
};

export type ValidatedExtensionMessage =
	| PageEventMessage
	| PopupCommandMessage
	| PageCommandMessage;

export type MessageParseResult =
	| {
			ok: true;
			path: MessagePath;
			source: PlatformSource | null;
			message: ValidatedExtensionMessage;
	  }
	| { ok: false; error: MessageValidationError };

const DEFAULT_LIMITS: Required<MessageLimits> = {
	maxPayloadBytes: 1_000_000,
	maxNodes: 20_000,
	maxDepth: 40,
	maxKeysPerObject: 500,
	maxArrayLength: 10_000,
	maxStringLength: 200_000,
};

const ERROR_MESSAGES: Record<MessageValidationError["code"], string> = {
	invalid_message: "message does not match the required schema",
	unsupported_version: "message protocol version is not supported",
	origin_not_allowed: "message did not come from a supported page",
	source_mismatch: "message source does not match the verified page",
	direction_mismatch: "message family is not allowed on this path",
	nonce_mismatch: "message correlation nonce is invalid",
	payload_too_large: "message exceeds the configured size limit",
	payload_too_complex: "message exceeds the configured complexity limit",
	sensitive_field:
		"message contains a forbidden credential or configuration field",
};

const SOURCE_HOSTS: Record<PlatformSource, ReadonlySet<string>> = {
	x: new Set(["x.com", "twitter.com"]),
	reddit: new Set(["www.reddit.com", "old.reddit.com", "reddit.com"]),
	github: new Set(["github.com"]),
};

const PAGE_EVENT_ACTIONS: Record<PlatformSource, ReadonlySet<string>> = {
	x: new Set(["ready", "saved", "bookmark", "page", "done", "error"]),
	reddit: new Set(["saved", "bookmark", "page", "done", "error"]),
	github: new Set(["page", "done", "bookmark", "error"]),
};

const PAGE_COMMAND_ACTIONS: Record<PlatformSource, ReadonlySet<string>> = {
	x: new Set(["configure", "backfill"]),
	reddit: new Set(["configure", "backfill"]),
	github: new Set(["configure", "backfill"]),
};

const ERROR_CODES = new Set([
	"platform_request_failed",
	"not_signed_in",
	"query_unavailable",
	"capture_failed",
	"page_shape_changed",
	"rate_limited",
]);

const SENSITIVE_KEYS = new Set([
	"authorization",
	"proxyauthorization",
	"cookie",
	"setcookie",
	"xcsrftoken",
	"xxsrftoken",
	"csrftoken",
	"ct0",
	"password",
	"passwd",
	"accesstoken",
	"refreshtoken",
]);

const CONFIG_SECRET_KEYS = new Set([
	"token",
	"server",
	"ingest",
	"ingestiontoken",
	"secret",
]);

function fail(code: MessageValidationError["code"]): MessageParseResult {
	return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type Inspection = "ok" | "invalid" | "too_complex" | "sensitive";

function inspectPayload(
	value: unknown,
	limits: Required<MessageLimits>,
): Inspection {
	const pending: Array<{ value: unknown; depth: number }> = [
		{ value, depth: 0 },
	];
	const seen = new Set<object>();
	let nodes = 0;

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		nodes++;
		if (nodes > limits.maxNodes || current.depth > limits.maxDepth)
			return "too_complex";

		const item = current.value;
		if (typeof item === "string") {
			if (item.length > limits.maxStringLength) return "too_complex";
			continue;
		}
		if (item === null || typeof item === "boolean") continue;
		if (typeof item === "number") {
			if (!Number.isFinite(item)) return "invalid";
			continue;
		}
		if (typeof item !== "object") return "invalid";
		if (seen.has(item)) return "invalid";
		seen.add(item);

		if (Array.isArray(item)) {
			if (item.length > limits.maxArrayLength) return "too_complex";
			for (let index = item.length - 1; index >= 0; index--) {
				pending.push({ value: item[index], depth: current.depth + 1 });
			}
			continue;
		}
		if (!isRecord(item)) return "invalid";

		const descriptors = Object.getOwnPropertyDescriptors(item);
		const keys = Object.keys(descriptors);
		if (keys.length > limits.maxKeysPerObject) return "too_complex";
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (
				!descriptor ||
				descriptor.get ||
				descriptor.set ||
				!("value" in descriptor)
			)
				return "invalid";
			if (SENSITIVE_KEYS.has(normalizedKey(key))) return "sensitive";
			pending.push({ value: descriptor.value, depth: current.depth + 1 });
		}
	}

	return "ok";
}

function serializedBytes(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return null;
		return new TextEncoder().encode(serialized).byteLength;
	} catch {
		return null;
	}
}

function deriveSource(urlValue: string): PlatformSource | null {
	try {
		const url = new URL(urlValue);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		for (const source of ["x", "reddit", "github"] as const) {
			if (SOURCE_HOSTS[source].has(url.hostname.toLowerCase())) return source;
		}
	} catch {
		// A malformed URL is simply not an allowed page origin.
	}
	return null;
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isSource(value: unknown): value is PlatformSource {
	return (
		value === "x" ||
		value === "reddit" ||
		value === "github"
	);
}

/**
 * A platform object identifier, kept to what an id can be.
 *
 * The background turns this into a capture addressed at one item, so a value
 * that could carry a path or a URL fragment has no business being one.
 */
/**
 * A link the page supplied, checked against the page it came from.
 *
 * A capture names a location, and the background stores whatever it is told;
 * an off-platform URL arriving from a compromised page has no business
 * becoming one.
 */
function isSourceUrl(value: unknown, source: PlatformSource): boolean {
	if (typeof value !== "string" || value.length > 2_000) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			SOURCE_HOSTS[source].has(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

/** A platform handle, which becomes part of a URL the background opens. */
function isHandle(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_.]{1,32}$/.test(value);
}

function isExternalId(value: unknown, source: PlatformSource): value is string {
	if (typeof value !== "string") return false;
	return source === "github"
		? /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(
				value,
			)
		: /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isNonce(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isRunId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validatePageEventShape(
	candidate: unknown,
	source: PlatformSource,
): candidate is PageEventMessage {
	if (!isRecord(candidate)) return false;
	const value = candidate;
	if (value.anansi !== "page-event" || typeof value.action !== "string")
		return false;
	if (!PAGE_EVENT_ACTIONS[source].has(value.action)) return false;

	const base = ["anansi", "messageVersion", "source", "nonce", "action"];
	switch (value.action) {
		case "ready":
			return (
				source === "x" &&
				hasOnlyKeys(value, [...base, "queryId"]) &&
				(value.queryId === null || typeof value.queryId === "string")
			);
		case "saved":
		case "scanned":
			return hasOnlyKeys(value, base);
		case "bookmark":
			return (
				hasOnlyKeys(value, [
					...base,
					"bookmarkAction",
					"externalId",
					"canonicalUrl",
					"raw",
				]) &&
				(value.bookmarkAction === "save" ||
					value.bookmarkAction === "unsave") &&
				isExternalId(value.externalId, source) &&
				(value.canonicalUrl === undefined ||
					isSourceUrl(value.canonicalUrl, source))
			);
		case "page":
			return (
				hasOnlyKeys(value, [...base, "runId", "raw", "page", "items", "cursor"]) &&
				(source !== "x" || isRunId(value.runId)) &&
				Object.hasOwn(value, "raw") &&
				isPositiveInteger(value.page) &&
				isNonNegativeInteger(value.items) &&
				(value.cursor === undefined ||
					(typeof value.cursor === "string" &&
						value.cursor.length > 0 &&
						value.cursor.length <= 2_000))
			);
		case "observed":
			return (
				hasOnlyKeys(value, [...base, "operation", "raw", "items"]) &&
				typeof value.operation === "string" &&
				value.operation.length > 0 &&
				value.operation.length <= 1_000 &&
				Object.hasOwn(value, "raw") &&
				isNonNegativeInteger(value.items)
			);
		case "identified":
			return hasOnlyKeys(value, [...base, "handle"]) && isHandle(value.handle);
		case "done":
			return (
				hasOnlyKeys(value, [...base, "runId", "pages", "items", "state"]) &&
				(source !== "x" || isRunId(value.runId)) &&
				isNonNegativeInteger(value.pages) &&
				isNonNegativeInteger(value.items) &&
				(value.state === undefined ||
					value.state === "complete" ||
					value.state === "limited" ||
					value.state === "cancelled")
			);
		case "error":
			return (
				hasOnlyKeys(value, [...base, "runId", "errorCode"]) &&
				(source !== "x" || isRunId(value.runId)) &&
				typeof value.errorCode === "string" &&
				ERROR_CODES.has(value.errorCode)
			);
		default:
			return false;
	}
}

function configContainsSecret(config: Record<string, unknown>): boolean {
	const pending: unknown[] = [config];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current !== "object" || current === null || seen.has(current))
			continue;
		seen.add(current);
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		for (const [key, child] of Object.entries(current)) {
			if (CONFIG_SECRET_KEYS.has(normalizedKey(key))) return true;
			pending.push(child);
		}
	}
	return false;
}

function validatePageCommandShape(
	candidate: unknown,
	source: PlatformSource,
): candidate is PageCommandMessage {
	if (!isRecord(candidate)) return false;
	const value = candidate;
	if (
		value.anansi !== "page-command" ||
		typeof value.action !== "string" ||
		!PAGE_COMMAND_ACTIONS[source].has(value.action) ||
		!hasOnlyKeys(value, [
			"anansi",
			"messageVersion",
			"source",
			"nonce",
			"action",
			"runId",
			"config",
		]) ||
		!isRecord(value.config) ||
		configContainsSecret(value.config)
	) {
		return false;
	}
	const runIdValid =
		source === "x" && value.action === "backfill"
			? isRunId(value.runId)
			: value.runId === undefined || isRunId(value.runId);
	return (
		runIdValid &&
		(value.config.source === undefined || value.config.source === source)
	);
}

function validatePopupCommandShape(
	candidate: unknown,
): candidate is PopupCommandMessage {
	if (!isRecord(candidate)) return false;
	const value = candidate;
	if (value.anansi !== "popup-command" || typeof value.action !== "string")
		return false;
	if (
		value.action === "queue-status" ||
		value.action === "reschedule" ||
		value.action === "save-page" ||
		value.action === "mirror-status" ||
		value.action === "mirror-on" ||
		value.action === "mirror-off"
	) {
		return hasOnlyKeys(value, ["anansi", "messageVersion", "action"]);
	}
	if (value.action === "retry-queue") {
		return (
			hasOnlyKeys(value, ["anansi", "messageVersion", "action", "source"]) &&
			(value.source === undefined || isSource(value.source))
		);
	}
	if (value.action === "start" || value.action === "stop") {
		return (
			hasOnlyKeys(value, ["anansi", "messageVersion", "action", "source"]) &&
			isSource(value.source)
		);
	}
	return false;
}

function validatePageTraffic(
	value: Record<string, unknown>,
	source: PlatformSource,
	expectedNonce: string,
	family: "page-event" | "page-command",
): MessageParseResult | null {
	if (!isSource(value.source) || value.source !== source)
		return fail("source_mismatch");
	if (
		!isNonce(expectedNonce) ||
		!isNonce(value.nonce) ||
		value.nonce !== expectedNonce
	) {
		return fail("nonce_mismatch");
	}

	if (family === "page-event") {
		if (!validatePageEventShape(value, source)) return fail("invalid_message");
	} else if (!validatePageCommandShape(value, source)) {
		if (isRecord(value.config) && configContainsSecret(value.config))
			return fail("sensitive_field");
		return fail("invalid_message");
	}
	return null;
}

/**
 * Validate and classify one message using trusted delivery context.
 *
 * All failures use fixed text. No payload value, URL, source claim, action,
 * credential-like field, or page-supplied error is reflected to a caller.
 */
function parseExtensionMessageUnchecked(
	value: unknown,
	context: MessageContext,
	options: MessageLimits = {},
): MessageParseResult {
	const limits = { ...DEFAULT_LIMITS, ...options };
	const inspection = inspectPayload(value, limits);
	if (inspection === "too_complex") return fail("payload_too_complex");
	if (inspection === "sensitive") return fail("sensitive_field");
	if (inspection === "invalid") return fail("invalid_message");

	const bytes = serializedBytes(value);
	if (bytes === null) return fail("invalid_message");
	if (bytes > limits.maxPayloadBytes) return fail("payload_too_large");
	if (!isRecord(value)) return fail("invalid_message");
	if (value.messageVersion !== MESSAGE_PROTOCOL_VERSION)
		return fail("unsupported_version");
	if (
		value.anansi !== "page-event" &&
		value.anansi !== "popup-command" &&
		value.anansi !== "page-command"
	) {
		return fail("invalid_message");
	}

	if (
		context.path === "runtime-to-background" &&
		context.sender.kind === "extension"
	) {
		if (value.anansi !== "popup-command") return fail("direction_mismatch");
		if (!validatePopupCommandShape(value)) return fail("invalid_message");
		return {
			ok: true,
			path: context.path,
			source: "source" in value && isSource(value.source) ? value.source : null,
			message: value,
		};
	}

	let url: string;
	let expectedNonce: string;
	if (context.path === "runtime-to-background") {
		if (context.sender.kind !== "tab" || !("expectedNonce" in context)) {
			return fail("direction_mismatch");
		}
		url = context.sender.url;
		expectedNonce = context.expectedNonce;
	} else {
		url = context.pageUrl;
		expectedNonce = context.expectedNonce;
	}
	const source = deriveSource(url);
	if (!source) return fail("origin_not_allowed");

	const expectedFamily =
		context.path === "relay-to-page" ? "page-command" : "page-event";
	if (value.anansi !== expectedFamily) return fail("direction_mismatch");
	const pageFailure = validatePageTraffic(
		value,
		source,
		expectedNonce,
		expectedFamily,
	);
	if (pageFailure) return pageFailure;

	return {
		ok: true,
		path: context.path,
		source,
		message: {
			...(value as unknown as PageEventMessage | PageCommandMessage),
			source,
		},
	};
}

export function parseExtensionMessage(
	value: unknown,
	context: MessageContext,
	options: MessageLimits = {},
): MessageParseResult {
	try {
		return parseExtensionMessageUnchecked(value, context, options);
	} catch {
		return fail("invalid_message");
	}
}
