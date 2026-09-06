import type { CaptureReceipt } from "@anansi/sources";
import type { OutboxRecord } from "./capture-queue.ts";

export type TransportResult =
	| { kind: "success"; receipt: unknown }
	| { kind: "network" }
	| { kind: "http"; status: number; retryAfterMs?: number; detail?: string }
	| { kind: "invalid_receipt" };

export interface CaptureTransport {
	send(record: OutboxRecord): Promise<TransportResult>;
}

export interface IngestTarget {
	ingest: string;
	token: string;
}

type ResolveTarget = () => Promise<IngestTarget | null>;
type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function retryAfter(value: string | null, now: number): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.round(seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function looksLikeReceipt(value: unknown): value is CaptureReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const receipt = value as Partial<CaptureReceipt>;
	return (
		typeof receipt.eventId === "string" &&
		(receipt.itemId === null || typeof receipt.itemId === "string") &&
		["created", "updated", "duplicate", "ignored_stale"].includes(
			String(receipt.outcome),
		)
	);
}

const MAX_ERROR_BODY = 4_096;
const MAX_ERROR_DETAIL = 180;

/** Read only a small, scalar, credential-scrubbed server explanation. */
export async function safeHttpErrorDetail(
	response: Response,
): Promise<string | undefined> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) return undefined;

	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	if (text.length === 0 || text.length > MAX_ERROR_BODY) return undefined;

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return undefined;

	const record = body as Record<string, unknown>;
	const value = [record.error, record.message, record.code].find(
		(candidate): candidate is string =>
			typeof candidate === "string" && candidate.trim().length > 0,
	);
	if (!value) return undefined;

	// Do not attempt clever partial redaction. A field that even mentions a
	// credential can contain an unfamiliar representation, so discard it whole.
	if (
		/(?:bearer|authori[sz]ation|cookie|password|secret|token|(?:api|session)[-_]?key|ct0|csrf)/i.test(
			value,
		)
	) {
		return undefined;
	}
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_ERROR_DETAIL
		? `${cleaned.slice(0, MAX_ERROR_DETAIL - 1)}…`
		: cleaned;
}

/** HTTP adapter for the queue's transport seam. It never exposes the token. */
export function createIngestTransport(
	resolveTarget: ResolveTarget,
	fetcher: Fetcher = fetch,
	now: () => number = Date.now,
): CaptureTransport {
	return {
		async send(record) {
			let target: IngestTarget | null;
			try {
				target = await resolveTarget();
			} catch {
				return { kind: "network" };
			}
			if (!target) return { kind: "network" };

			let response: Response;
			try {
				response = await fetcher(target.ingest, {
					method: "POST",
					headers: {
						accept: "application/json",
						authorization: `Bearer ${target.token}`,
						"content-type": "application/json",
						"idempotency-key": record.eventId,
					},
					body: JSON.stringify(record.capture),
				});
			} catch {
				return { kind: "network" };
			}

			if (!response.ok) {
				const detail = await safeHttpErrorDetail(response);
				return {
					kind: "http",
					status: response.status,
					...(detail ? { detail } : {}),
					...(retryAfter(response.headers.get("retry-after"), now()) ===
					undefined
						? {}
						: {
								retryAfterMs: retryAfter(
									response.headers.get("retry-after"),
									now(),
								),
							}),
				};
			}

			try {
				const text = await response.text();
				if (text.length > 65_536) return { kind: "invalid_receipt" };
				const receipt = JSON.parse(text) as unknown;
				return looksLikeReceipt(receipt)
					? { kind: "success", receipt }
					: { kind: "invalid_receipt" };
			} catch {
				return { kind: "invalid_receipt" };
			}
		},
	};
}
