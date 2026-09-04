import type {
	BookmarkCapture,
	CaptureOutcome,
	CaptureReceipt,
	ItemEventCapture,
	NormalizedItem,
} from "@anansi/sources";
import { and, eq, sql } from "drizzle-orm";
import { upsertItemsInTransaction } from "./queries.ts";
import { captureEvents, itemSourceLinks, items } from "./schema.ts";
import type { AnansiDb } from "./types.ts";

export type CaptureApplicationErrorCode =
	| "missing_item"
	| "missing_parsed_items";

export class CaptureApplicationError extends Error {
	constructor(
		public readonly code: CaptureApplicationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CaptureApplicationError";
	}
}

function readReceipt(serialized: string): CaptureReceipt {
	return JSON.parse(serialized) as CaptureReceipt;
}

async function priorReceipt(
	db: AnansiDb,
	eventId: string,
): Promise<CaptureReceipt | null> {
	const [event] = await db
		.select({ receipt: captureEvents.receipt })
		.from(captureEvents)
		.where(eq(captureEvents.eventId, eventId))
		.limit(1);
	return event ? readReceipt(event.receipt) : null;
}

async function recordReceipt(
	db: AnansiDb,
	capture: BookmarkCapture,
	receipt: CaptureReceipt,
): Promise<void> {
	await db.insert(captureEvents).values({
		eventId: capture.eventId,
		source: capture.source,
		externalId:
			capture.payloadType === "item_event" ? capture.externalId : null,
		action: capture.action,
		captureMethod: capture.captureMethod,
		observedAt: capture.observedAt,
		receivedAt: Math.floor(Date.now() / 1000),
		itemId: receipt.itemId,
		outcome: receipt.outcome,
		receipt: JSON.stringify(receipt),
	});
}

async function findItem(db: AnansiDb, capture: ItemEventCapture) {
	const [item] = await db
		.select({
			id: items.id,
			platformSaved: items.platformSaved,
			lastSourceEventAt: items.lastSourceEventAt,
		})
		.from(items)
		.where(
			and(
				eq(items.source, capture.source),
				eq(items.externalId, capture.externalId),
			),
		)
		.limit(1);
	return item;
}

function receipt(
	capture: BookmarkCapture,
	itemId: string | null,
	outcome: CaptureOutcome,
	parsed?: number,
): CaptureReceipt {
	return {
		eventId: capture.eventId,
		itemId,
		outcome,
		...(parsed === undefined ? {} : { parsed }),
	};
}

async function applyPlatformEvent(
	db: AnansiDb,
	capture: ItemEventCapture,
): Promise<CaptureReceipt> {
	let existing = await findItem(db, capture);
	if (
		existing?.lastSourceEventAt &&
		existing.lastSourceEventAt > capture.observedAt
	) {
		return receipt(capture, existing.id, "ignored_stale");
	}

	const wasNew = !existing;
	if (capture.action === "save") {
		if (!capture.normalizedItem && !existing) {
			throw new CaptureApplicationError(
				"missing_item",
				"a new save requires normalized item content",
			);
		}
		if (capture.normalizedItem) {
			await upsertItemsInTransaction(db, [capture.normalizedItem], {
				captureOrigin: capture.captureMethod,
			});
			existing = await findItem(db, capture);
		}
	} else if (!existing) {
		return receipt(capture, null, "ignored_stale");
	}

	if (!existing) {
		throw new CaptureApplicationError(
			"missing_item",
			"capture item could not be resolved",
		);
	}

	await db
		.update(items)
		.set({
			platformSaved: capture.action === "save" ? 1 : 0,
			removedFromSourceAt:
				capture.action === "save" ? null : capture.observedAt,
			lastSourceEventAt: capture.observedAt,
		})
		.where(eq(items.id, existing.id));

	return receipt(capture, existing.id, wasNew ? "created" : "updated");
}

async function applyChromeEvent(
	db: AnansiDb,
	capture: ItemEventCapture,
): Promise<CaptureReceipt> {
	const link = capture.sourceLink;
	if (!link) {
		throw new CaptureApplicationError(
			"missing_item",
			"Chrome capture requires a source link",
		);
	}

	let existing = await findItem(db, capture);
	const [priorLink] = await db
		.select({
			itemId: itemSourceLinks.itemId,
			observedAt: itemSourceLinks.observedAt,
		})
		.from(itemSourceLinks)
		.where(
			and(
				eq(itemSourceLinks.kind, link.kind),
				eq(itemSourceLinks.externalId, link.externalId),
			),
		)
		.limit(1);

	if (priorLink && priorLink.observedAt > capture.observedAt) {
		return receipt(capture, priorLink.itemId, "ignored_stale");
	}

	const wasNew = !existing;
	if (capture.action === "save") {
		if (!capture.normalizedItem && !existing) {
			throw new CaptureApplicationError(
				"missing_item",
				"a new Chrome save requires normalized item content",
			);
		}
		if (capture.normalizedItem) {
			await upsertItemsInTransaction(db, [capture.normalizedItem], {
				captureOrigin: capture.captureMethod,
			});
			existing = await findItem(db, capture);
		}
	} else if (!existing) {
		return receipt(capture, null, "ignored_stale");
	}

	if (!existing) {
		throw new CaptureApplicationError(
			"missing_item",
			"Chrome capture item could not be resolved",
		);
	}

	await db
		.insert(itemSourceLinks)
		.values({
			kind: link.kind,
			externalId: link.externalId,
			itemId: existing.id,
			present: capture.action === "save" ? 1 : 0,
			observedAt: capture.observedAt,
		})
		.onConflictDoUpdate({
			target: [itemSourceLinks.kind, itemSourceLinks.externalId],
			set: {
				itemId: existing.id,
				present: capture.action === "save" ? 1 : 0,
				observedAt: capture.observedAt,
			},
		});

	if (priorLink?.itemId && priorLink.itemId !== existing.id) {
		await refreshLinkedPresence(db, priorLink.itemId, capture.observedAt);
	}
	await refreshLinkedPresence(db, existing.id, capture.observedAt);

	return receipt(capture, existing.id, wasNew ? "created" : "updated");
}

async function refreshLinkedPresence(
	db: AnansiDb,
	itemId: string,
	observedAt: number,
): Promise<void> {
	const [presence] = await db
		.select({ count: sql<number>`count(*)` })
		.from(itemSourceLinks)
		.where(
			and(eq(itemSourceLinks.itemId, itemId), eq(itemSourceLinks.present, 1)),
		);
	const [item] = await db
		.select({ lastSourceEventAt: items.lastSourceEventAt })
		.from(items)
		.where(eq(items.id, itemId))
		.limit(1);
	const present = Number(presence?.count ?? 0) > 0;

	await db
		.update(items)
		.set({
			platformSaved: present ? 1 : 0,
			removedFromSourceAt: present ? null : observedAt,
			lastSourceEventAt: Math.max(item?.lastSourceEventAt ?? 0, observedAt),
		})
		.where(eq(items.id, itemId));
}

async function applyWithinTransaction(
	db: AnansiDb,
	capture: BookmarkCapture,
	parsedItems: NormalizedItem[],
): Promise<CaptureReceipt> {
	const replay = await priorReceipt(db, capture.eventId);
	if (replay) return replay;

	let result: CaptureReceipt;
	if (capture.payloadType === "raw_page") {
		if (parsedItems.length === 0) {
			throw new CaptureApplicationError(
				"missing_parsed_items",
				"a raw capture page must parse to at least one item",
			);
		}
		const applied = await upsertItemsInTransaction(db, parsedItems, {
			captureOrigin: capture.captureMethod,
		});
		const outcome: CaptureOutcome =
			applied.inserted > 0 ? "created" : "updated";
		result = receipt(capture, null, outcome, parsedItems.length);
	} else if (capture.captureMethod === "chrome_bookmark") {
		result = await applyChromeEvent(db, capture);
	} else {
		result = await applyPlatformEvent(db, capture);
	}

	await recordReceipt(db, capture, result);
	return result;
}

/**
 * Apply one capture and its receipt atomically. Replaying an event returns the
 * first receipt without touching item state again.
 */
export async function applyCapture(
	db: AnansiDb,
	capture: BookmarkCapture,
	parsedItems: NormalizedItem[] = [],
): Promise<CaptureReceipt> {
	return await db.transaction(async (transaction) =>
		applyWithinTransaction(
			transaction as unknown as AnansiDb,
			capture,
			parsedItems,
		),
	);
}
