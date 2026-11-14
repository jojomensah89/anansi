/**
 * How long an import in a tab it opened may go without progress.
 *
 * A fixed limit ends a long import that is working. This one restarts with each
 * page, so only an import that has stopped moving expires.
 */
export function createRunDeadlines<Timer>(deps: {
	schedule: (run: () => void, ms: number) => Timer;
	cancel: (timer: Timer) => void;
}) {
	const active = new Map<string, { timer: Timer; ms: number; expire: () => void }>();

	const start = (runId: string, ms: number, expire: () => void) => {
		const existing = active.get(runId);
		if (existing) deps.cancel(existing.timer);
		const timer = deps.schedule(() => {
			active.delete(runId);
			expire();
		}, ms);
		active.set(runId, { timer, ms, expire });
	};

	return {
		start,
		/** A page arrived. Does nothing for a run without a deadline. */
		progress(runId: string) {
			const existing = active.get(runId);
			if (existing) start(runId, existing.ms, existing.expire);
		},
	};
}
