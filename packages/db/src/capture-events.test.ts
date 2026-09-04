import { describe, expect, test } from "bun:test";
import type {
	ItemEventCapture,
	NormalizedItem,
	RawPageCapture,
} from "@anansi/sources";
import { eq } from "drizzle-orm";
import { applyCapture, CaptureApplicationError } from "./capture-events.ts";
import { captureEvents, itemSourceLinks, items } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

const normalized = (
	overrides: Partial<NormalizedItem> = {},
): NormalizedItem => ({
	source: "x",
	externalId: "tweet-1",
	url: "https://x.com/anansi/status/tweet-1",
	kind: "post",
	body: "A durable bookmark",
	savedAt: 1_788_390_000,
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
	observedAt: 1_788_390_000,
	captureMethod: "platform_event",
	normalizedItem: normalized(),
	...overrides,
});

describe("applyCapture", () => {
	test("creates an item and returns the same receipt when the event is replayed", async () => {
		const db = openTestDb();
		const capture = itemEvent();

		const first = await applyCapture(db, capture);
		const replay = await applyCapture(db, capture);
		const storedItems = await db.select().from(items);
		const storedEvents = await db.select().from(captureEvents);

		expect(first).toMatchObject({
			eventId: capture.eventId,
			outcome: "created",
		});
		expect(first.itemId).toBeString();
		expect(replay).toEqual(first);
		expect(storedItems).toHaveLength(1);
		expect(storedEvents).toHaveLength(1);
		expect(storedItems[0]?.captureOrigin).toBe("platform_event");
		expect(storedEvents[0]?.captureMethod).toBe("platform_event");
	});

	test("retains an unsaved item and ignores an older delayed save", async () => {
		const db = openTestDb();
		await applyCapture(db, itemEvent({ observedAt: 200, eventId: "save-200" }));
		await applyCapture(
			db,
			itemEvent({
				action: "unsave",
				eventId: "unsave-300",
				observedAt: 300,
				normalizedItem: undefined,
			}),
		);

		const stale = await applyCapture(
			db,
			itemEvent({ eventId: "save-250", observedAt: 250 }),
		);
		const [afterStale] = await db.select().from(items);

		expect(stale.outcome).toBe("ignored_stale");
		expect(afterStale?.platformSaved).toBe(0);
		expect(afterStale?.removedFromSourceAt).toBe(300);
		expect(afterStale?.lastSourceEventAt).toBe(300);

		await applyCapture(db, itemEvent({ eventId: "save-400", observedAt: 400 }));
		const [restored] = await db.select().from(items);
		expect(restored?.platformSaved).toBe(1);
		expect(restored?.removedFromSourceAt).toBeNull();
		expect(restored?.lastSourceEventAt).toBe(400);
	});

	test("keeps a web item present until its final Chrome bookmark node is removed", async () => {
		const db = openTestDb();
		const webItem = normalized({
			source: "web",
			externalId: "sha256:web",
			url: "https://example.com/article",
			kind: "article",
		});
		const chrome = (
			node: string,
			action: "save" | "unsave",
			observedAt: number,
		): ItemEventCapture =>
			itemEvent({
				eventId: `${action}-${node}-${observedAt}`,
				source: "web",
				action,
				externalId: webItem.externalId,
				canonicalUrl: webItem.url,
				observedAt,
				captureMethod: "chrome_bookmark",
				normalizedItem: action === "save" ? webItem : undefined,
				sourceLink: { kind: "chrome_bookmark", externalId: node },
			});

		await applyCapture(db, chrome("node-a", "save", 100));
		await applyCapture(db, chrome("node-b", "save", 110));
		await applyCapture(db, chrome("node-a", "unsave", 120));

		let [stored] = await db.select().from(items);
		expect(stored?.platformSaved).toBe(1);

		await applyCapture(db, chrome("node-b", "unsave", 130));
		[stored] = await db.select().from(items);
		expect(stored).toBeDefined();
		if (!stored) throw new Error("expected the Chrome-backed web item");
		const links = await db
			.select()
			.from(itemSourceLinks)
			.where(eq(itemSourceLinks.itemId, stored.id));

		expect(stored?.platformSaved).toBe(0);
		expect(stored?.removedFromSourceAt).toBe(130);
		expect(links).toHaveLength(2);
		expect(links.every((link) => link.present === 0)).toBe(true);
	});

	test("moves a Chrome node link when the bookmark URL changes", async () => {
		const db = openTestDb();
		const firstItem = normalized({
			source: "web",
			externalId: "sha256:first",
			url: "https://example.com/first",
			kind: "article",
		});
		const secondItem = normalized({
			source: "web",
			externalId: "sha256:second",
			url: "https://example.com/second",
			kind: "article",
		});
		const chromeSave = (
			eventId: string,
			observedAt: number,
			webItem: NormalizedItem,
		): ItemEventCapture =>
			itemEvent({
				eventId,
				source: "web",
				externalId: webItem.externalId,
				canonicalUrl: webItem.url,
				observedAt,
				captureMethod: "chrome_bookmark",
				normalizedItem: webItem,
				sourceLink: { kind: "chrome_bookmark", externalId: "node-a" },
			});

		await applyCapture(db, chromeSave("first-url", 100, firstItem));
		await applyCapture(db, chromeSave("changed-url", 200, secondItem));

		const stored = await db.select().from(items);
		const first = stored.find((row) => row.externalId === firstItem.externalId);
		const second = stored.find(
			(row) => row.externalId === secondItem.externalId,
		);
		const [link] = await db.select().from(itemSourceLinks);

		expect(first?.platformSaved).toBe(0);
		expect(first?.removedFromSourceAt).toBe(200);
		expect(second?.platformSaved).toBe(1);
		expect(link?.itemId).toBe(second?.id);
	});

	test("applies a raw page as one idempotent event with a parsed count", async () => {
		const db = openTestDb();
		const capture: RawPageCapture = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "x-run-1-page-1",
			source: "x",
			action: "snapshot",
			observedAt: 1_788_390_000,
			captureMethod: "platform_import",
			runId: "x-run-1",
			page: 1,
			raw: { data: {} },
		};
		const parsed = [
			normalized({ externalId: "tweet-a" }),
			normalized({ externalId: "tweet-b" }),
		];

		const first = await applyCapture(db, capture, parsed);
		const replay = await applyCapture(db, capture, parsed);

		expect(first).toMatchObject({
			itemId: null,
			outcome: "created",
			parsed: 2,
		});
		expect(replay).toEqual(first);
		expect(await db.select().from(items)).toHaveLength(2);
		expect((await db.select().from(items)).every((item) => item.captureOrigin === "platform_import")).toBe(true);
		expect((await db.select().from(captureEvents))[0]?.captureMethod).toBe("platform_import");
	});

	test("keeps the first arrival provenance through later updates", async () => {
		const db = openTestDb();
		const imported: RawPageCapture = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "import-first",
			source: "x",
			action: "snapshot",
			observedAt: 100,
			captureMethod: "platform_import",
			runId: "import-run",
			page: 1,
			raw: {},
		};
		await applyCapture(db, imported, [normalized()]);
		await applyCapture(db, itemEvent({ eventId: "live-later", observedAt: 200 }));

		const [stored] = await db.select().from(items);
		expect(stored?.captureOrigin).toBe("platform_import");
	});

	test("stores no event when a content-less save has no existing item", async () => {
		const db = openTestDb();
		const capture = itemEvent({
			eventId: "missing-content",
			normalizedItem: undefined,
		});

		let error: unknown;
		try {
			await applyCapture(db, capture);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(CaptureApplicationError);
		expect(error).toMatchObject({ code: "missing_item" });
		expect(await db.select().from(captureEvents)).toHaveLength(0);
		expect(await db.select().from(items)).toHaveLength(0);
	});
});
