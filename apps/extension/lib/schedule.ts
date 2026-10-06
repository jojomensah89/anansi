export const DAILY_SYNC_MINUTES = 24 * 60;
export const SYNC_ALARM = "anansi-sync";
export const OUTBOX_RETRY_DELAY_MS = 2_500;

export interface OneShotAlarmScheduler {
	create(name: string, info: { when: number }): void;
	get?(name: string): Promise<{ scheduledTime?: number } | undefined>;
}

const alarmTails = new WeakMap<object, Promise<unknown>>();
/** Serial get/create prevents a later concurrent wake from postponing work. */
export function scheduleEarliestAlarm(alarms: OneShotAlarmScheduler, name: string, at: number): Promise<void> {
	const task = (alarmTails.get(alarms) ?? Promise.resolve()).then(async () => {
		const existing = await alarms.get?.(name);
		if (existing?.scheduledTime !== undefined && existing.scheduledTime <= at) return;
		await alarms.create(name, { when: at });
	});
	alarmTails.set(alarms, task.catch(() => {}));
	return task;
}

/** A failed capture must wake the worker even if its lifecycle snapshot is stale. */
export function scheduleOutboxRetry(
	alarms: OneShotAlarmScheduler,
	name: string,
	now: number,
): void {
	if (alarms.get) void scheduleEarliestAlarm(alarms, name, now + OUTBOX_RETRY_DELAY_MS).catch(() => {});
	else alarms.create(name, { when: now + OUTBOX_RETRY_DELAY_MS });
}

export interface AlarmScheduler {
	get(name: string): Promise<{ periodInMinutes?: number } | undefined>;
	clear(name: string): Promise<boolean>;
	create(
		name: string,
		info: { periodInMinutes: number; delayInMinutes: number },
	): void;
}

/** One recovery policy, rather than a preference hidden in the popup. */
export async function scheduleDailyCatchUp(
	alarms: AlarmScheduler,
): Promise<void> {
	const existing = await alarms.get(SYNC_ALARM);
	if (existing?.periodInMinutes === DAILY_SYNC_MINUTES) return;
	await alarms.clear(SYNC_ALARM);
	alarms.create(SYNC_ALARM, {
		periodInMinutes: DAILY_SYNC_MINUTES,
		delayInMinutes: DAILY_SYNC_MINUTES,
	});
}
