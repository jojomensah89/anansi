import { describe, expect, test } from "bun:test";
import type { ItemEventCapture } from "@anansi/sources";
import type { OutboxRecord } from "./capture-queue.ts";
import { createIngestTransport } from "./ingest-transport.ts";

const capture: ItemEventCapture = {
	schemaVersion: 1,
	payloadType: "item_event",
	eventId: "transport-event",
	source: "web",
	action: "save",
	externalId: "web-transport-event",
	canonicalUrl: "https://example.com/transport",
	observedAt: 1_788_390_000,
	captureMethod: "toolbar",
	normalizedItem: {
		source: "web",
		externalId: "web-transport-event",
		url: "https://example.com/transport",
		kind: "article",
		body: "Transport test",
		savedAt: 1_788_390_000,
		savedAtIsExact: true,
		metrics: {},
		media: [],
		links: [],
		raw: {},
	},
};

const record: OutboxRecord = {
	eventId: capture.eventId,
	source: capture.source,
	capture,
	payloadHash: "hash",
	state: "uploading",
	attempts: 1,
	nextAttemptAt: 1_000,
	createdAt: 1_000,
	updatedAt: 1_000,
	sizeBytes: 500,
};

describe("ingest transport", () => {
	test("sends the capture with bearer auth and a stable idempotency key", async () => {
		let calledUrl = "";
		let calledInit: RequestInit | undefined;
		const transport = createIngestTransport(
			async () => ({
				ingest: "https://anansi.example/api/ingest",
				token: "secret-token",
			}),
			async (input, init) => {
				calledUrl = String(input);
				calledInit = init;
				return new Response(
					JSON.stringify({
						eventId: capture.eventId,
						itemId: "item-1",
						outcome: "created",
					}),
					{ status: 200 },
				);
			},
		);

		const response = await transport.send(record);
		const headers = new Headers(calledInit?.headers);
		expect(response).toMatchObject({ kind: "success" });
		expect(calledUrl).toBe("https://anansi.example/api/ingest");
		expect(headers.get("authorization")).toBe("Bearer secret-token");
		expect(headers.get("idempotency-key")).toBe(capture.eventId);
		expect(JSON.parse(String(calledInit?.body))).toEqual(capture);
	});

	test("parses Retry-After without reading or reflecting an error body", async () => {
		const transport = createIngestTransport(
			async () => ({
				ingest: "https://anansi.example/api/ingest",
				token: "token",
			}),
			async () =>
				new Response("cookie=session-secret", {
					status: 429,
					headers: { "retry-after": "120" },
				}),
			Date.now,
		);

		expect(await transport.send(record)).toEqual({
			kind: "http",
			status: 429,
			retryAfterMs: 120_000,
		});
	});

	test("classifies network failures and malformed success bodies", async () => {
		const target = async () => ({
			ingest: "https://anansi.example/api/ingest",
			token: "token",
		});
		const offline = createIngestTransport(target, async () => {
			throw new Error("offline with secret-token");
		});
		const malformed = createIngestTransport(
			target,
			async () => new Response("not-json", { status: 200 }),
		);

		expect(await offline.send(record)).toEqual({ kind: "network" });
		expect(await malformed.send(record)).toEqual({ kind: "invalid_receipt" });
	});
});
