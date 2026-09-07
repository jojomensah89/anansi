import { expect, test } from "bun:test";
import {
	DAILY_SYNC_MINUTES,
	OUTBOX_RETRY_DELAY_MS,
	SYNC_ALARM,
	scheduleDailyCatchUp,
	scheduleOutboxRetry,
} from "./schedule.ts";

test("a failed outbox item gets a concrete one-shot retry", () => {
	const created: Array<{ name: string; info: { when: number } }> = [];
	scheduleOutboxRetry(
		{
			create(name, info) {
				created.push({ name, info });
			},
		},
		"anansi-outbox",
		10_000,
	);

	expect(OUTBOX_RETRY_DELAY_MS).toBe(2_500);
	expect(created).toEqual([
		{ name: "anansi-outbox", info: { when: 12_500 } },
	]);
});

test("catch-up is fixed to once every 24 hours", async () => {
	const cleared: string[] = [];
	const created: Array<{
		name: string;
		info: { periodInMinutes: number; delayInMinutes: number };
	}> = [];
	await scheduleDailyCatchUp({
		async get() {
			return undefined;
		},
		async clear(name) {
			cleared.push(name);
			return true;
		},
		create(name, info) {
			created.push({ name, info });
		},
	});

	expect(DAILY_SYNC_MINUTES).toBe(1_440);
	expect(cleared).toEqual([SYNC_ALARM]);
	expect(created).toEqual([
		{
			name: SYNC_ALARM,
			info: { periodInMinutes: 1_440, delayInMinutes: 1_440 },
		},
	]);
});

test("worker restarts do not postpone an existing daily alarm", async () => {
	let cleared = 0;
	let created = 0;
	await scheduleDailyCatchUp({
		async get() {
			return { periodInMinutes: DAILY_SYNC_MINUTES };
		},
		async clear() {
			cleared++;
			return true;
		},
		create() {
			created++;
		},
	});

	expect(cleared).toBe(0);
	expect(created).toBe(0);
});

test("an old custom interval is replaced once", async () => {
	let cleared = 0;
	let createdPeriod = 0;
	await scheduleDailyCatchUp({
		async get() {
			return { periodInMinutes: 60 };
		},
		async clear() {
			cleared++;
			return true;
		},
		create(_name, info) {
			createdPeriod = info.periodInMinutes;
		},
	});

	expect(cleared).toBe(1);
	expect(createdPeriod).toBe(DAILY_SYNC_MINUTES);
});
