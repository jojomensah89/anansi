import type {
	BookmarkCapture,
	CaptureOutcome,
	CaptureReceipt,
	ItemEventCapture,
	NormalizedItem,
} from "@anansi/sources";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { atomicWrite, type AtomicStatement } from "./atomic.ts";
import { prepareUpsertItems, type UpsertPlan } from "./queries.ts";
import { captureEvents, itemSourceLinks, itemSourceStates, items } from "./schema.ts";
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

interface CapturePlan {
	receipt: CaptureReceipt;
	statements(db: AnansiDb): AtomicStatement[];
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

function recordReceiptStatement(
	db: AnansiDb,
	capture: BookmarkCapture,
	receipt: CaptureReceipt,
): AtomicStatement {
	return db.insert(captureEvents).values({
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

function plannedItemId(plan: UpsertPlan, capture: ItemEventCapture): string {
	const id = plan.itemIds.get(`${capture.source}:${capture.externalId}`);
	if (!id) {
		throw new CaptureApplicationError(
			"missing_item",
			"capture item could not be resolved",
		);
	}
	return id;
}

function sourceStateStatement(db: AnansiDb, capture: ItemEventCapture): AtomicStatement {
	return db.insert(itemSourceStates).values({ source: capture.source, externalId: capture.externalId,
		platformSaved: capture.action === "save" ? 1 : 0, observedAt: capture.observedAt })
		.onConflictDoUpdate({ target: [itemSourceStates.source, itemSourceStates.externalId],
			set: { platformSaved: capture.action === "save" ? 1 : 0, observedAt: capture.observedAt },
			setWhere: lte(itemSourceStates.observedAt, capture.observedAt) });
}

function applyExplicitState(db: AnansiDb, source: string, externalId?: string | string[]): AtomicStatement {
	const state = sql`(select platform_saved from item_source_states where source = ${items.source} and external_id = ${items.externalId})`;
	const time = sql`(select observed_at from item_source_states where source = ${items.source} and external_id = ${items.externalId})`;
	return db.update(items).set({ platformSaved: state, lastSourceEventAt: time,
		removedFromSourceAt: sql`case when ${state} = 0 then ${time} else null end`,
	}).where(and(eq(items.source, source), Array.isArray(externalId)
		? sql`${items.externalId} in (select value from json_each(${JSON.stringify(externalId)}))`
		: externalId === undefined ? undefined : eq(items.externalId, externalId),
		sql`exists (select 1 from item_source_states where source = ${items.source} and external_id = ${items.externalId})`));
}

async function planPlatformEvent(
	db: AnansiDb,
	capture: ItemEventCapture,
): Promise<CapturePlan> {
	const existing = await findItem(db, capture);
	const [state] = await db.select().from(itemSourceStates).where(and(
		eq(itemSourceStates.source, capture.source), eq(itemSourceStates.externalId, capture.externalId))).limit(1);
	if (Math.max(existing?.lastSourceEventAt ?? 0, state?.observedAt ?? 0) > capture.observedAt) {
		return {
			receipt: receipt(capture, existing?.id ?? null, "ignored_stale"),
			statements: () => [],
		};
	}

	if (capture.action === "save" && !capture.normalizedItem && !existing) {
		throw new CaptureApplicationError(
			"missing_item",
			"a new save requires normalized item content",
		);
	}
	if (capture.action === "unsave" && !existing) {
		return {
			receipt: receipt(capture, null, "ignored_stale"),
			statements: (target) => [sourceStateStatement(target, capture)],
		};
	}

	const upsert = capture.normalizedItem
		? await prepareUpsertItems(db, [capture.normalizedItem], {
				captureOrigin: capture.captureMethod,
			})
		: null;
	const itemId = upsert ? plannedItemId(upsert, capture) : existing?.id;
	if (!itemId) {
		throw new CaptureApplicationError(
			"missing_item",
			"capture item could not be resolved",
		);
	}

	return {
		receipt: receipt(capture, itemId, existing ? "updated" : "created"),
		statements: (target) => [
			sourceStateStatement(target, capture),
			...(upsert?.statements(target) ?? []),
			target
				.update(items)
				.set({
					platformSaved: capture.action === "save" ? 1 : 0,
					removedFromSourceAt:
						capture.action === "save" ? null : capture.observedAt,
					lastSourceEventAt: capture.observedAt,
				})
				.where(
					and(
						eq(items.id, itemId),
						or(
							isNull(items.lastSourceEventAt),
							lte(items.lastSourceEventAt, capture.observedAt),
						),
					),
				),
			applyExplicitState(target, capture.source, capture.externalId),
		],
	};
}

async function linkedState(db: AnansiDb, itemId: string) {
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
	return {
		count: Number(presence?.count ?? 0),
		lastSourceEventAt: item?.lastSourceEventAt ?? null,
	};
}

async function planChromeEvent(
	db: AnansiDb,
	capture: ItemEventCapture,
): Promise<CapturePlan> {
	const link = capture.sourceLink;
	if (!link) {
		throw new CaptureApplicationError(
			"missing_item",
			"Chrome capture requires a source link",
		);
	}

	const existing = await findItem(db, capture);
	const [priorLink] = await db
		.select({
			itemId: itemSourceLinks.itemId,
			present: itemSourceLinks.present,
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
		return {
			receipt: receipt(capture, priorLink.itemId, "ignored_stale"),
			statements: () => [],
		};
	}
	if (capture.action === "save" && !capture.normalizedItem && !existing) {
		throw new CaptureApplicationError(
			"missing_item",
			"a new Chrome save requires normalized item content",
		);
	}
	if (capture.action === "unsave" && !existing) {
		return {
			receipt: receipt(capture, null, "ignored_stale"),
			statements: () => [],
		};
	}

	const upsert = capture.normalizedItem
		? await prepareUpsertItems(db, [capture.normalizedItem], {
				captureOrigin: capture.captureMethod,
			})
		: null;
	const itemId = upsert ? plannedItemId(upsert, capture) : existing?.id;
	if (!itemId) {
		throw new CaptureApplicationError(
			"missing_item",
			"Chrome capture item could not be resolved",
		);
	}

	const affected = new Map<string, Awaited<ReturnType<typeof linkedState>>>();
	for (const id of new Set([itemId, priorLink?.itemId].filter(Boolean) as string[])) {
		affected.set(id, await linkedState(db, id));
	}
	const nextPresent = capture.action === "save" ? 1 : 0;
	if (priorLink?.present === 1) {
		const state = affected.get(priorLink.itemId)!;
		state.count = Math.max(0, state.count - 1);
	}
	if (nextPresent === 1) {
		const state = affected.get(itemId)!;
		state.count += 1;
	}

	return {
		receipt: receipt(capture, itemId, existing ? "updated" : "created"),
		statements: (target) => [
			...(upsert?.statements(target) ?? []),
			target
				.insert(itemSourceLinks)
				.values({
					kind: link.kind,
					externalId: link.externalId,
					itemId,
					present: nextPresent,
					observedAt: capture.observedAt,
				})
				.onConflictDoUpdate({
					target: [itemSourceLinks.kind, itemSourceLinks.externalId],
					set: { itemId, present: nextPresent, observedAt: capture.observedAt },
				}),
			...Array.from(affected, ([id, state]) =>
				target
					.update(items)
					.set({
						platformSaved: state.count > 0 ? 1 : 0,
						removedFromSourceAt:
							state.count > 0 ? null : capture.observedAt,
						lastSourceEventAt: Math.max(
							state.lastSourceEventAt ?? 0,
							capture.observedAt,
						),
					})
					.where(eq(items.id, id)),
			),
		],
	};
}

async function planCapture(
	db: AnansiDb,
	capture: BookmarkCapture,
	parsedItems: NormalizedItem[],
): Promise<CapturePlan> {
	if (capture.payloadType === "raw_page") {
		if (parsedItems.length === 0) {
			throw new CaptureApplicationError(
				"missing_parsed_items",
				"a raw capture page must parse to at least one item",
			);
		}
		const upsert = await prepareUpsertItems(db, parsedItems, {
			captureOrigin: capture.captureMethod,
		});
		return {
			receipt: receipt(
				capture,
				null,
				upsert.result.inserted > 0 ? "created" : "updated",
				parsedItems.length,
			),
			statements: (target) => [
				...upsert.statements(target),
				applyExplicitState(target, capture.source, parsedItems.map((item) => item.externalId)),
			],
		};
	}
	return capture.captureMethod === "chrome_bookmark"
		? planChromeEvent(db, capture)
		: planPlatformEvent(db, capture);
}

/**
 * Apply one capture and its receipt atomically. SQLite uses its native
 * callback transaction; D1 executes the predeclared statements as one batch.
 * Replaying an event returns the first receipt without touching item state.
 */
export async function applyCapture(
	db: AnansiDb,
	capture: BookmarkCapture,
	parsedItems: NormalizedItem[] = [],
): Promise<CaptureReceipt> {
	const replay = await priorReceipt(db, capture.eventId);
	if (replay) return replay;

	const plan = await planCapture(db, capture, parsedItems);
	try {
		await atomicWrite(db, (target) => [
			...plan.statements(target),
			// The receipt references the item created above. A concurrent replay
			// makes this unique insert fail and rolls the whole batch back.
			recordReceiptStatement(target, capture, plan.receipt),
		]);
		return plan.receipt;
	} catch (error) {
		// Another request may have committed this event between the read and
		// the batch. Return that durable receipt; otherwise preserve the failure.
		const concurrentReplay = await priorReceipt(db, capture.eventId);
		if (concurrentReplay) return concurrentReplay;
		throw error;
	}
}
