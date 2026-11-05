import { describe, expect, test } from "bun:test";
import {
	createQueueDestinationGuard,
	requireOriginPermission,
	type LifecycleStorage,
} from "./connection-lifecycle.ts";
import type { OutboxRecord } from "./capture-queue.ts";

function setup(initialOrigin: string | null = "https://one.example", provenOrigin: string | null = null) {
	const values: Record<string, unknown> = {};
	const storage: LifecycleStorage = {
		async get(key) {
			return { [key]: values[key] };
		},
		async set(next) { Object.assign(values, next); },
		async remove(key) { delete values[key]; },
	};
	let origin = initialOrigin;
	let records: OutboxRecord[] = [];
	const guard = createQueueDestinationGuard({
		storage,
		listRecords: async () => records,
		getOrigin: async () => origin,
		getProvenOrigin: async () => provenOrigin,
	});
	return {
		guard,
		values,
		setOrigin(value: string | null) { origin = value; },
		setRecords(value: OutboxRecord[]) { records = value; },
	};
}

const record = { eventId: "event-1" } as OutboxRecord;

describe("connection lifecycle", () => {
	test("binds admitted captures to the current server and blocks switching while pending", async () => {
		const state = setup();
		const admission = await state.guard.beginEnqueue();
		expect(admission.ok).toBe(true);
		expect(state.values.anansiQueueDestinationOrigin).toBe("https://one.example");
		state.setRecords([record]);
		state.setOrigin("https://two.example");
		expect(await state.guard.canConnectTo("https://two.example")).toMatchObject({ ok: false });
		expect(await state.guard.beginEnqueue()).toMatchObject({ ok: false });
		expect(await state.guard.canDeliver()).toBe(false);
		if (admission.ok) await admission.release();
	});

	test("delivers only to the bound server and releases the binding when the queue empties", async () => {
		const state = setup();
		const admission = await state.guard.beginEnqueue();
		expect(admission.ok).toBe(true);
		state.setRecords([record]);
		if (admission.ok) await admission.release();
		expect(await state.guard.canDeliver()).toBe(true);
		state.setOrigin(null);
		expect(await state.guard.canDeliver()).toBe(false);
		state.setRecords([]);
		expect(await state.guard.canDeliver()).toBe(false);
		expect(state.values.anansiQueueDestinationOrigin).toBeUndefined();
	});

	test("does not admit captures before a connection exists", async () => {
		const state = setup(null);
		expect(await state.guard.beginEnqueue()).toMatchObject({ ok: false });
	});

	test("holds the selected destination through the asynchronous durable write", async () => {
		const state = setup();
		const reservation = await state.guard.beginEnqueue();
		expect(reservation.ok).toBe(true);
		state.setOrigin("https://two.example");
		expect(await state.guard.canConnectTo("https://two.example")).toMatchObject({ ok: false });
		state.setRecords([record]);
		if (reservation.ok) await reservation.release();
		expect(await state.guard.canConnectTo("https://two.example")).toMatchObject({ ok: false });
	});

	test("leaves unowned legacy records paused until their destination is explicitly chosen", async () => {
		const state = setup("https://one.example");
		state.setRecords([record]);
		expect(await state.guard.canDeliver()).toBe(false);
		expect(await state.guard.canConnectTo("https://one.example")).toMatchObject({ ok: false, code: "legacy_queue_unowned" });
		expect(await state.guard.adoptCurrentOrigin()).toEqual({ ok: true });
		expect(await state.guard.canDeliver()).toBe(true);
	});

	test("does not treat a provisional first connection as proof on a repeated connect", async () => {
		const state = setup("https://two.example");
		state.setRecords([record]);
		expect(await state.guard.canConnectTo("https://two.example")).toMatchObject({ ok: false, code: "legacy_queue_unowned" });
		// Reopening settings and submitting the same provisional connection must
		// still leave the destination decision to the explicit adoption action.
		expect(await state.guard.canConnectTo("https://two.example")).toMatchObject({ ok: false, code: "legacy_queue_unowned" });
		expect(state.values.anansiQueueDestinationOrigin).toBeUndefined();
		expect(await state.guard.canDeliver()).toBe(false);
	});

	test("migrates legacy records only when committed origin metadata proves the destination", async () => {
		const state = setup("https://one.example", "https://one.example");
		state.setRecords([record]);
		expect(await state.guard.canDeliver()).toBe(true);
	});

	test("clears a stale owner after queue drain so a later connection can switch", async () => {
		const state = setup();
		const admission = await state.guard.beginEnqueue();
		if (admission.ok) await admission.release();
		state.setRecords([record]);
		state.setRecords([]); // Worker stopped after the final delete, before metadata cleanup.
		expect(await state.guard.canConnectTo("https://two.example")).toEqual({ ok: true });
		expect(state.values.anansiQueueDestinationOrigin).toBeUndefined();
	});

	test("blocks switching while an import is active even before its first queued page", async () => {
		const values: Record<string, unknown> = {};
		const guard = createQueueDestinationGuard({
			storage: {
				async get(key) { return { [key]: values[key] }; },
				async set(next) { Object.assign(values, next); },
				async remove(key) { delete values[key]; },
			},
			listRecords: async () => [],
			hasPendingWork: async () => true,
			getOrigin: async () => "https://one.example",
			getProvenOrigin: async () => "https://one.example",
		});
		expect(await guard.canConnectTo("https://two.example")).toMatchObject({ ok: false });
		expect(await guard.canConnectTo("https://one.example")).toEqual({ ok: true });
	});

	test("requires an explicit successful optional-origin permission request", async () => {
		const calls: string[] = [];
		const alreadyGranted = await requireOriginPermission("https://one.example", {
			async contains({ origins }) { calls.push(`contains:${origins[0]}`); return false; },
			async request({ origins }) { calls.push(`request:${origins[0]}`); return true; },
		});
		expect(alreadyGranted).toBe(false);
		expect(calls).toEqual([
			"contains:https://one.example/*",
			"request:https://one.example/*",
		]);
		await expect(requireOriginPermission("https://two.example", {
			async contains() { return false; },
			async request() { return false; },
		})).rejects.toThrow("Permission to access the Worker URL was denied");
		await expect(requireOriginPermission("https://two.example", {})).rejects.toThrow("could not request access");
		expect(await requireOriginPermission("https://already.example", {
			async contains() { return true; },
			async request() { throw new Error("should not request an existing grant"); },
		})).toBe(true);
	});
});
