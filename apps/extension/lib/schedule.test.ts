import { expect, test } from "bun:test";
import {
	OUTBOX_RETRY_DELAY_MS,
	scheduleEarliestAlarm,
	scheduleOutboxRetry,
} from "./schedule.ts";

test("concurrent retry scheduling retains the earliest persisted alarm", async () => {
	let scheduledTime: number | undefined = 5_000;
	const alarms = {
		async get() { return scheduledTime === undefined ? undefined : { scheduledTime }; },
		create(_name: string, info: { when: number }) { scheduledTime = info.when; },
	};
	await Promise.all([scheduleEarliestAlarm(alarms, "retry", 9_000), scheduleEarliestAlarm(alarms, "retry", 3_000), scheduleEarliestAlarm(alarms, "retry", 7_000)]);
	expect(scheduledTime).toBe(3_000);
	scheduledTime = undefined;
	await scheduleEarliestAlarm(alarms, "retry", 7_000);
	expect((await alarms.get())?.scheduledTime).toBe(7_000);
});

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


