export const DAILY_SYNC_MINUTES = 24 * 60;
export const SYNC_ALARM = "anansi-sync";

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
