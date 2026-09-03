import {
	type AnansiDb,
	applyCapture,
	CaptureApplicationError,
	upsertItems,
} from "@anansi/db";
import {
	type NormalizedItem,
	parseBookmarkCapture,
	parseBookmarksPage,
	parseItemList,
	parseSavedListing,
	parseStarredPage,
} from "@anansi/sources";

export const MAX_INGEST_BODY_BYTES = 2_000_000;

export interface IngestResult {
	status: number;
	body: unknown;
	/** Whether the route should start bounded, asynchronous media fetching. */
	syncMedia: boolean;
}

type BodyReadResult =
	| { ok: true; value: unknown }
	| { ok: false; status: number; error: string };

const result = (
	body: unknown,
	status = 200,
	syncMedia = false,
): IngestResult => ({
	status,
	body,
	syncMedia,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(
	request: Request,
	maxBytes: number,
): Promise<BodyReadResult> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		/^\d+$/.test(declared) &&
		Number(declared) > maxBytes
	) {
		return { ok: false, status: 413, error: "request body is too large" };
	}
	if (!request.body) return { ok: false, status: 400, error: "invalid json" };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return { ok: false, status: 413, error: "request body is too large" };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, status: 400, error: "invalid json" };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
	} catch {
		return { ok: false, status: 400, error: "invalid json" };
	}
}

const SENSITIVE_DIAGNOSTIC_KEYS = [
	"auth",
	"cookie",
	"credential",
	"csrf",
	"password",
	"secret",
	"session",
	"token",
];

function safeKey(key: string): string {
	const lower = key.toLowerCase();
	if (SENSITIVE_DIAGNOSTIC_KEYS.some((fragment) => lower.includes(fragment))) {
		return "[redacted]";
	}
	return key.slice(0, 60);
}

/** Keys and types only, with a strict output budget and no attacker values. */
function describeShape(
	value: unknown,
	depth = 3,
	budget = { remaining: 64 },
): unknown {
	if (budget.remaining-- <= 0) return "…";
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) {
		return value.length === 0
			? "[]"
			: [
					`array(${value.length})`,
					depth > 0 ? describeShape(value[0], depth - 1, budget) : "…",
				];
	}
	if (typeof value !== "object") return typeof value;
	if (depth === 0) return "object";

	const entries: [string, unknown][] = [];
	for (const [key, child] of Object.entries(
		value as Record<string, unknown>,
	).slice(0, 8)) {
		if (budget.remaining <= 0) break;
		entries.push([safeKey(key), describeShape(child, depth - 1, budget)]);
	}
	return Object.fromEntries(entries);
}

function parseRawItems(
	source: string,
	raw: unknown,
	importedAt: number,
): NormalizedItem[] | null {
	switch (source) {
		case "x":
			return parseBookmarksPage(raw, { importedAt }).items;
		case "github":
			return parseStarredPage(raw, { importedAt });
		case "reddit":
			return parseSavedListing(raw, { importedAt });
		case "tiktok":
			return parseItemList(raw, { importedAt });
		default:
			return null;
	}
}

function isVersionedCapture(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) &&
		("schemaVersion" in value || "payloadType" in value || "eventId" in value)
	);
}

function hasMedia(items: NormalizedItem[]): boolean {
	return items.some((item) => item.media.length > 0);
}

async function ingestLegacy(
	db: AnansiDb,
	body: Record<string, unknown>,
): Promise<IngestResult> {
	let normalized: unknown[];
	if (body.raw !== undefined) {
		const source = typeof body.source === "string" ? body.source : "x";
		let parsed: NormalizedItem[] | null;
		try {
			parsed = parseRawItems(source, body.raw, Math.floor(Date.now() / 1000));
		} catch {
			return result(
				{
					error: "payload could not be parsed",
					shape: describeShape(body.raw),
				},
				422,
			);
		}
		if (!parsed)
			return result({ error: `unknown source: ${body.source}` }, 400);
		if (parsed.length === 0) {
			return result(
				{
					error: "payload parsed to zero items",
					parsed: 0,
					shape: describeShape(body.raw),
				},
				422,
			);
		}
		normalized = parsed;
	} else if (Array.isArray(body.items)) {
		normalized = body.items;
	} else {
		return result(
			{ error: "expected { source, raw } or { items: [...] }" },
			400,
		);
	}

	const applied = await upsertItems(db, normalized as NormalizedItem[]);
	return result(
		{ ...applied, parsed: normalized.length },
		200,
		applied.mediaRows > 0,
	);
}

async function ingestVersioned(
	db: AnansiDb,
	body: unknown,
	idempotencyKey: string | null,
): Promise<IngestResult> {
	const parsedCapture = parseBookmarkCapture(body);
	if (!parsedCapture.ok) {
		const status = parsedCapture.error.code === "payload_too_large" ? 413 : 400;
		return result(
			{ error: parsedCapture.error.message, code: parsedCapture.error.code },
			status,
		);
	}

	const capture = parsedCapture.capture;
	if (!idempotencyKey || idempotencyKey !== capture.eventId) {
		return result({ error: "Idempotency-Key must match capture eventId" }, 400);
	}

	let normalized: NormalizedItem[] = [];
	if (capture.payloadType === "raw_page") {
		try {
			normalized =
				parseRawItems(capture.source, capture.raw, capture.observedAt) ?? [];
		} catch {
			return result(
				{
					error: "payload could not be parsed",
					shape: describeShape(capture.raw),
				},
				422,
			);
		}
		if (normalized.length === 0) {
			return result(
				{
					error: "payload parsed to zero items",
					parsed: 0,
					shape: describeShape(capture.raw),
				},
				422,
			);
		}
	}

	try {
		const receipt = await applyCapture(db, capture, normalized);
		const itemContent =
			capture.payloadType === "raw_page"
				? normalized
				: capture.action === "save" && capture.normalizedItem
					? [capture.normalizedItem]
					: [];
		return result(receipt, 200, hasMedia(itemContent));
	} catch (error) {
		if (error instanceof CaptureApplicationError) {
			return result({ error: error.message, code: error.code }, 422);
		}
		throw error;
	}
}

/**
 * Parse and apply either legacy ingest input or one versioned capture. Auth is
 * deliberately enforced by the route before this reads any request bytes.
 */
export async function ingestCapture(
	db: AnansiDb,
	request: Request,
	maxBytes = MAX_INGEST_BODY_BYTES,
): Promise<IngestResult> {
	const read = await readBoundedJson(request, maxBytes);
	if (!read.ok) return result({ error: read.error }, read.status);
	if (!isRecord(read.value)) {
		return result({ error: "ingest body must be an object" }, 400);
	}
	return isVersionedCapture(read.value)
		? ingestVersioned(db, read.value, request.headers.get("idempotency-key"))
		: ingestLegacy(db, read.value);
}
