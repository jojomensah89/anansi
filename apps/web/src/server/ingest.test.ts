import { describe, expect, test } from "bun:test";
import { type AnansiDb, captureEvents, items } from "@anansi/db";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type {
	ItemEventCapture,
	NormalizedItem,
	RawPageCapture,
} from "@anansi/sources";
import { ingestCapture } from "./ingest.ts";

const now = 1_788_390_000;

const openTestDb = () => {
	const db = openLocalDb(":memory:");
	migrateLocalDb(db);
	return db as unknown as AnansiDb;
};

const normalized = (
	overrides: Partial<NormalizedItem> = {},
): NormalizedItem => ({
	source: "x",
	externalId: "tweet-1",
	url: "https://x.com/anansi/status/tweet-1",
	kind: "post",
	body: "A durable bookmark",
	savedAt: now,
	savedAtIsExact: true,
	metrics: {},
	media: [],
	links: [],
	raw: {},
	...overrides,
});

const itemEvent = (
	overrides: Partial<ItemEventCapture> = {},
): ItemEventCapture => ({
	schemaVersion: 1,
	payloadType: "item_event",
	eventId: "event-save-1",
	source: "x",
	action: "save",
	externalId: "tweet-1",
	canonicalUrl: "https://x.com/anansi/status/tweet-1",
	observedAt: now,
	captureMethod: "platform_event",
	normalizedItem: normalized(),
	...overrides,
});

const request = (body: unknown, idempotencyKey?: string) =>
	new Request("https://anansi.test/api/ingest", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
		},
		body: JSON.stringify(body),
	});

const redditRaw = {
	kind: "Listing",
	data: {
		after: null,
		children: [
			{
				kind: "t3",
				data: {
					id: "1abc23",
					name: "t3_1abc23",
					title: "A local-first bookmark library",
					selftext: "Stored locally",
					permalink: "/r/selfhosted/comments/1abc23/local_first/",
					subreddit: "selfhosted",
					author: "anansi",
					created_utc: now - 100,
					score: 42,
					num_comments: 3,
				},
			},
		],
	},
};

describe("ingestCapture", () => {
	test("preserves the legacy normalized-items response shape", async () => {
		const db = openTestDb();
		const result = await ingestCapture(db, request({ items: [normalized()] }));

		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			inserted: 1,
			updated: 0,
			mediaRows: 0,
			parsed: 1,
		});
		expect(result.syncMedia).toBe(false);
	});

	test("preserves legacy raw parsing", async () => {
		const db = openTestDb();
		const result = await ingestCapture(
			db,
			request({ source: "reddit", raw: redditRaw }),
		);

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ inserted: 1, updated: 0, parsed: 1 });
		expect(await db.select().from(items)).toHaveLength(1);
	});

	test("requires a matching idempotency key for versioned captures", async () => {
		const db = openTestDb();
		const missing = await ingestCapture(db, request(itemEvent()));
		const mismatch = await ingestCapture(
			db,
			request(itemEvent(), "different-event"),
		);

		expect(missing.status).toBe(400);
		expect(mismatch.status).toBe(400);
		expect(missing.body).toEqual({
			error: "Idempotency-Key must match capture eventId",
		});
		expect(await db.select().from(captureEvents)).toHaveLength(0);
	});

	test("returns the stable receipt when a versioned event is replayed", async () => {
		const db = openTestDb();
		const capture = itemEvent();

		const first = await ingestCapture(db, request(capture, capture.eventId));
		const replay = await ingestCapture(db, request(capture, capture.eventId));

		expect(first.status).toBe(200);
		expect(replay.body).toEqual(first.body);
		expect(first.body).toMatchObject({
			eventId: capture.eventId,
			outcome: "created",
		});
		expect(await db.select().from(captureEvents)).toHaveLength(1);
	});

	test("parses a versioned raw page server-side", async () => {
		const db = openTestDb();
		const capture: RawPageCapture = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "reddit-run-1-page-1",
			source: "reddit",
			action: "snapshot",
			observedAt: now,
			captureMethod: "platform_import",
			runId: "reddit-run-1",
			page: 1,
			raw: redditRaw,
		};

		const result = await ingestCapture(db, request(capture, capture.eventId));

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			eventId: capture.eventId,
			outcome: "created",
			parsed: 1,
		});
	});

	test("does not acknowledge a raw page that parses to zero items", async () => {
		const db = openTestDb();
		const capture: RawPageCapture = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "reddit-empty-page",
			source: "reddit",
			action: "snapshot",
			observedAt: now,
			captureMethod: "platform_import",
			runId: "reddit-run-empty",
			page: 1,
			raw: { data: { children: [] } },
		};

		const result = await ingestCapture(db, request(capture, capture.eventId));

		expect(result.status).toBe(422);
		expect(result.body).toMatchObject({
			error: "payload parsed to zero items",
			parsed: 0,
		});
		expect(await db.select().from(captureEvents)).toHaveLength(0);
	});

	test("rejects unsupported versions, sources, actions, and malformed items", async () => {
		const invalid = [
			{ ...itemEvent(), schemaVersion: 99 },
			{ ...itemEvent(), source: "github" },
			{ ...itemEvent(), action: "delete" },
			{ ...itemEvent(), normalizedItem: { ...normalized(), savedAt: "today" } },
		];

		for (const capture of invalid) {
			const db = openTestDb();
			const result = await ingestCapture(db, request(capture, capture.eventId));
			expect(result.status).toBe(400);
			expect(await db.select().from(captureEvents)).toHaveLength(0);
		}
	});

	test("caps the request body before JSON parsing", async () => {
		const db = openTestDb();
		const result = await ingestCapture(
			db,
			request({ padding: "x".repeat(2_000_000) }),
		);

		expect(result.status).toBe(413);
		expect(result.body).toEqual({ error: "request body is too large" });
	});

	test("an unsave never requests media synchronization or deletes content", async () => {
		const db = openTestDb();
		const save = itemEvent({
			normalizedItem: normalized({
				media: [
					{
						kind: "image",
						originUrl: "https://pbs.twimg.com/media/example.jpg",
					},
				],
			}),
		});
		await ingestCapture(db, request(save, save.eventId));

		const unsave = itemEvent({
			eventId: "event-unsave-1",
			action: "unsave",
			observedAt: now + 1,
			normalizedItem: undefined,
		});
		const result = await ingestCapture(db, request(unsave, unsave.eventId));

		expect(result.status).toBe(200);
		expect(result.syncMedia).toBe(false);
		expect(await db.select().from(items)).toHaveLength(1);
	});

	test("never reflects credentials or rejected raw values", async () => {
		const db = openTestDb();
		const capture = {
			...itemEvent(),
			raw: {
				cookie: "session-cookie-secret",
				authorization: "Bearer platform-secret",
			},
		};
		const result = await ingestCapture(db, request(capture, capture.eventId));
		const serialized = JSON.stringify(result.body).toLowerCase();

		expect(result.status).toBe(400);
		expect(serialized).not.toContain("session-cookie-secret");
		expect(serialized).not.toContain("platform-secret");
		expect(serialized).not.toContain("test-token");
	});
});
