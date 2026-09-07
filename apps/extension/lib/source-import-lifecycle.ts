import {
	type ActiveSourceRunState,
	type CaptureSource,
	SOURCE_RUN_LEASE_MS,
	type SourceRunState,
	type SourceRuns,
} from "./source-runs.ts";

export type SourceImportMode = "full" | "live";

/** The lifecycle never receives raw browser messages; the host validates those first. */
export interface SourceImportPage {
	source: CaptureSource;
	runId: string;
	page: number;
	items: number;
	cursor?: string | null;
	raw: unknown;
	captureMethod: "platform_import" | "platform_event";
	eventId: string;
}

export interface SourceImportLifecycleDependencies {
	runs: SourceRuns;
	/** Must resolve only after the raw page is durably queued. */
	enqueuePage(page: SourceImportPage): Promise<void>;
	/** Saves are flushed only after the pages carrying their content are queued. */
	flushPendingSaves?(source: CaptureSource): Promise<void>;
	/** The host may revalidate the server kill switch at lifecycle boundaries. */
	isEnabled?(source: CaptureSource): Promise<boolean>;
	now?: () => number;
}

export class SourceImportLifecycleError extends Error {
	constructor(
		readonly code:
			| "queue_full"
			| "record_too_large"
			| "queue_failed"
			| "stale_run",
		message: string,
	) {
		super(message);
		this.name = "SourceImportLifecycleError";
	}
}

export type SourceImportEffect =
	| {
			kind: "schedule-recovery";
			source: CaptureSource;
			at: number;
			runId: string;
	  }
	| { kind: "clear-recovery"; source: CaptureSource; runId?: string }
	| {
			kind: "close-owned-tab";
			source: CaptureSource;
			runId: string;
			expectedTabId?: number;
	  }
	| { kind: "process-pending-refresh"; source: CaptureSource; runId?: string }
	| {
			kind: "status";
			source: CaptureSource;
			runId?: string;
			patch: Record<string, unknown>;
	  };

export type SourceImportOutcome = {
	kind:
		| "started"
		| "already-running"
		| "bound-tab"
		| "accepted-page"
		| "ignored-stale"
		| "queue-failed"
		| "completed"
		| "limited"
		| "cancelled"
		| "disabled"
		| "failed"
		| "rate-limited";
	source: CaptureSource;
	runId?: string;
	page?: number;
	items?: number;
	effects: SourceImportEffect[];
	errorCode?: string;
	/** A durable acknowledgement is distinct from provider delivery. */
	durable?: boolean;
};

export type StartImportResult =
	| (SourceImportOutcome & {
			kind: "started" | "already-running";
			run: ActiveSourceRunState;
	  })
	| (SourceImportOutcome & {
			kind: "disabled";
			run: SourceRunState;
	  });

export interface SourceImportLifecycle {
	start(
		source: CaptureSource,
		mode?: SourceImportMode,
	): Promise<StartImportResult>;
	bindTab(
		source: CaptureSource,
		runId: string,
		tabId: number,
		owned: boolean,
	): Promise<SourceImportOutcome>;
	page(
		page: Omit<SourceImportPage, "eventId"> & { tabId?: number },
	): Promise<SourceImportOutcome>;
	complete(input: {
		source: CaptureSource;
		runId: string;
		tabId?: number;
		state?: "complete" | "limited" | "cancelled";
		/** Observe-only scans do not count as the one-time history import. */
		initialImport?: boolean;
		pages?: number;
		items?: number;
	}): Promise<SourceImportOutcome>;
	stop(source: CaptureSource, runId?: string): Promise<SourceImportOutcome>;
	fail(input: {
		source: CaptureSource;
		runId: string;
		tabId?: number;
		code: string;
		retryAfterMs?: number;
	}): Promise<SourceImportOutcome>;
}

function recoveryAt(now: number, updatedAt: number): number {
	return Math.max(now + 100, updatedAt + SOURCE_RUN_LEASE_MS + 100);
}

function stale(source: CaptureSource, runId?: string): SourceImportOutcome {
	return { kind: "ignored-stale", source, runId, effects: [] };
}

function matchesTab(
	run: { activeTabId?: number },
	tabId: number | undefined,
): boolean {
	return (
		tabId === undefined ||
		run.activeTabId === undefined ||
		run.activeTabId === tabId
	);
}

/**
 * Shared ownership and acknowledgement rules for page and session imports.
 *
 * This module deliberately returns browser effects rather than touching tabs or
 * alarms. The background host remains the authenticated message boundary and
 * the only place allowed to perform browser operations.
 */
export function createSourceImportLifecycle(
	dependencies: SourceImportLifecycleDependencies,
): SourceImportLifecycle {
	const { runs, enqueuePage, flushPendingSaves, isEnabled } = dependencies;
	const now = dependencies.now ?? Date.now;

	const current = async (source: CaptureSource, runId: string) => {
		const run = await runs.current(source);
		return run.phase === "running" && run.runId === runId ? run : null;
	};

	// A page is not acknowledged until enqueuePage resolves.  Serialize the
	// whole transition (including that await) so a concurrent done/stop/error
	// cannot finish the run between the queue write and cursor acknowledgement.
	const tails = new Map<CaptureSource, Promise<void>>();
	const serialize = <T>(source: CaptureSource, work: () => Promise<T>) => {
		const previous = tails.get(source) ?? Promise.resolve();
		const task = previous.then(work, work);
		tails.set(
			source,
			task.then(
				() => undefined,
				() => undefined,
			),
		);
		return task;
	};

	const schedule = (
		source: CaptureSource,
		run: { updatedAt: number; runId: string },
	) => ({
		kind: "schedule-recovery" as const,
		source,
		at: recoveryAt(now(), run.updatedAt),
		runId: run.runId,
	});

	const disabled = async (
		source: CaptureSource,
		runId: string,
	): Promise<SourceImportOutcome> => {
		const stopped = await runs.stopForRun(source, runId);
		if (!stopped.stopped) return stale(source, runId);
		return {
			kind: "disabled",
			source,
			runId,
			effects: [
				{ kind: "clear-recovery", source, runId },
				...(stopped.tabId !== null
					? [
							{
								kind: "close-owned-tab" as const,
								source,
								runId,
								expectedTabId: stopped.tabId,
							},
						]
					: []),
				{
					kind: "status",
					source,
					runId,
					patch: { startedAt: null, message: "switched off in Sources" },
				},
			],
		};
	};

	const queueFailureCode = (error: unknown): string => {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "queue_full" || error.code === "record_too_large")
		) {
			return error.code;
		}
		return "queue_failed";
	};

	const poisonQueueRun = async (
		source: CaptureSource,
		runId: string,
		run: Pick<SourceRunState, "createdTabId">,
		error: unknown,
	): Promise<SourceImportOutcome> => {
		const errorCode = queueFailureCode(error);
		if (!(await runs.noteErrorForRun(source, runId, errorCode)))
			return stale(source, runId);
		if (!(await runs.finishForRun(source, runId))) return stale(source, runId);
		const effects: SourceImportEffect[] = [
			{ kind: "clear-recovery", source, runId },
			{
				kind: "status",
				source,
				runId,
				patch: {
					startedAt: null,
					message:
						errorCode === "queue_full"
							? "capture queue is full; retry after delivery catches up"
							: "capture could not be queued; retry the import",
				},
			},
		];
		if (run.createdTabId !== undefined)
			effects.push({
				kind: "close-owned-tab",
				source,
				runId,
				expectedTabId: run.createdTabId,
			});
		return {
			kind: "queue-failed",
			source,
			runId,
			effects,
			errorCode,
			durable: false,
		};
	};

	const cancelRun = async (
		source: CaptureSource,
		runId: string,
		message = "stopped",
	): Promise<SourceImportOutcome> => {
		const stopped = await runs.stopForRun(source, runId);
		if (!stopped.stopped) return stale(source, runId);
		return {
			kind: "cancelled",
			source,
			runId,
			effects: [
				{ kind: "clear-recovery", source, runId },
				...(stopped.tabId !== null
					? [
							{
								kind: "close-owned-tab" as const,
								source,
								runId,
								expectedTabId: stopped.tabId,
							},
						]
					: []),
				{
					kind: "status",
					source,
					runId,
					patch: { startedAt: null, message },
				},
			],
		};
	};

	return {
		async start(source, mode = "full") {
			if (isEnabled && !(await isEnabled(source))) {
				const run = await runs.current(source);
				if (run.phase === "running" && run.runId) {
					const stopped = await disabled(source, run.runId);
					return {
						...stopped,
						kind: "disabled",
						run: await runs.current(source),
					};
				}
				return {
					kind: "disabled",
					source,
					run,
					effects: [
						{
							kind: "status",
							source,
							patch: { startedAt: null, message: "switched off in Sources" },
						},
					],
				};
			}
			const begun = await runs.begin(source, mode);
			const effects: SourceImportEffect[] = [schedule(source, begun.run)];
			if (begun.replacedOwnedTabId !== undefined) {
				effects.unshift({
					kind: "close-owned-tab",
					source,
					runId: begun.replacedRunId ?? begun.run.runId,
					expectedTabId: begun.replacedOwnedTabId,
				});
			}
			if (!begun.started) {
				return {
					kind: "already-running",
					source,
					run: begun.run,
					effects: [
						...effects,
						{
							kind: "status",
							source,
							runId: begun.run.runId,
							patch: { message: "a capture is already running" },
						},
					],
				};
			}
			return {
				kind: "started",
				source,
				run: begun.run,
				runId: begun.run.runId,
				effects,
			};
		},

		async bindTab(source, runId, tabId, owned) {
			return serialize(source, async () => {
				if (!(await runs.setActiveTab(source, runId, tabId)))
					return stale(source, runId);
				if (owned && !(await runs.setOwnedTabForRun(source, runId, tabId)))
					return stale(source, runId);
				return { kind: "bound-tab", source, runId, effects: [] };
			});
		},

		async page(input) {
			return serialize(input.source, async () => {
				const run = await current(input.source, input.runId);
				if (!run || !matchesTab(run, input.tabId))
					return stale(input.source, input.runId);
				if (isEnabled && !(await isEnabled(input.source)))
					return disabled(input.source, input.runId);

				const identity = await runs.capturePageForRun(
					input.source,
					input.runId,
					input.page,
				);
				if (!identity) return stale(input.source, input.runId);
				try {
					await enqueuePage({
						...input,
						eventId: identity.eventId,
						page: identity.page,
					});
				} catch (error) {
					return {
						...(await poisonQueueRun(input.source, input.runId, run, error)),
						page: identity.page,
					};
				}

				// Live refreshes must never replace the full-import resume cursor.
				if (run.runMode === "full" && input.cursor !== undefined) {
					if (
						!(await runs.setCursorForRun(
							input.source,
							input.runId,
							input.cursor,
						))
					)
						return stale(input.source, input.runId);
				}
				const latest = await current(input.source, input.runId);
				if (!latest) return stale(input.source, input.runId);
				return {
					kind: "accepted-page",
					source: input.source,
					runId: input.runId,
					page: identity.page,
					items: input.items,
					effects: [
						schedule(input.source, {
							updatedAt: latest.updatedAt,
							runId: input.runId,
						}),
					],
					durable: true,
				};
			});
		},

		async complete(input) {
			return serialize(input.source, async () => {
				const run = await current(input.source, input.runId);
				if (!run || !matchesTab(run, input.tabId))
					return stale(input.source, input.runId);
				if (isEnabled && !(await isEnabled(input.source)))
					return disabled(input.source, input.runId);
				if (input.state === "cancelled")
					return cancelRun(input.source, input.runId);
				if (input.state === "limited") {
					const stopped = await runs.stopForRun(input.source, input.runId);
					if (!stopped.stopped) return stale(input.source, input.runId);
					return {
						kind: "limited",
						source: input.source,
						runId: input.runId,
						effects: [
							{
								kind: "clear-recovery",
								source: input.source,
								runId: input.runId,
							},
							...(stopped.tabId !== null
								? [
										{
											kind: "close-owned-tab" as const,
											source: input.source,
											runId: input.runId,
											expectedTabId: stopped.tabId,
										},
									]
								: []),
							{
								kind: "status",
								source: input.source,
								runId: input.runId,
								patch: {
									startedAt: null,
									message:
										"import paused at its safety limit; press Resume to continue",
								},
							},
						],
					};
				}

				if (!run.pendingRefresh && flushPendingSaves) {
					await flushPendingSaves(input.source);
				}
				if (run.runMode === "full" && input.initialImport !== false) {
					if (
						!(await runs.completeInitialImportForRun(input.source, input.runId))
					)
						return stale(input.source, input.runId);
				}
				if (!(await runs.finishForRun(input.source, input.runId)))
					return stale(input.source, input.runId);
				const effects: SourceImportEffect[] = [
					{
						kind: "clear-recovery",
						source: input.source,
						runId: input.runId,
					},
					{
						kind: "status",
						source: input.source,
						runId: input.runId,
						patch: {
							startedAt: null,
							lastRun: now(),
							...(input.pages === undefined ? {} : { pages: input.pages }),
							...(input.items === undefined ? {} : { items: input.items }),
							message: null,
						},
					},
				];
				if (run.createdTabId !== undefined) {
					effects.push({
						kind: "close-owned-tab",
						source: input.source,
						runId: input.runId,
						expectedTabId: run.createdTabId,
					});
				}
				if (run.pendingRefresh)
					effects.push({
						kind: "process-pending-refresh",
						source: input.source,
						runId: input.runId,
					});
				return {
					kind: "completed",
					source: input.source,
					runId: input.runId,
					effects,
				};
			});
		},

		async stop(source, runId) {
			return serialize(source, async () => {
				const currentRun = await runs.current(source);
				const expected = runId ?? currentRun.runId;
				if (!expected) return stale(source);
				return cancelRun(source, expected);
			});
		},

		async fail(input) {
			return serialize(input.source, async () => {
				const run = await current(input.source, input.runId);
				if (!run || !matchesTab(run, input.tabId))
					return stale(input.source, input.runId);
				if (
					!(await runs.noteErrorForRun(input.source, input.runId, input.code))
				)
					return stale(input.source, input.runId);
				if (input.code === "rate_limited") {
					return {
						kind: "rate-limited",
						source: input.source,
						runId: input.runId,
						errorCode: input.code,
						effects: [
							{
								kind: "schedule-recovery",
								source: input.source,
								runId: input.runId,
								at: Math.max(
									now() + SOURCE_RUN_LEASE_MS + 100,
									now() +
										Math.max(0, input.retryAfterMs ?? SOURCE_RUN_LEASE_MS),
								),
							},
							{
								kind: "status",
								source: input.source,
								runId: input.runId,
								patch: {
									startedAt: null,
									message:
										"the platform temporarily limited the import; Anansi will retry automatically",
								},
							},
						],
					};
				}
				if (!(await runs.finishForRun(input.source, input.runId)))
					return stale(input.source, input.runId);
				const effects: SourceImportEffect[] = [
					{
						kind: "clear-recovery",
						source: input.source,
						runId: input.runId,
					},
						{
							kind: "status",
							source: input.source,
							runId: input.runId,
							patch: { startedAt: null, message: input.code },
					},
				];
				if (run.createdTabId !== undefined)
					effects.push({
						kind: "close-owned-tab",
						source: input.source,
						runId: input.runId,
						expectedTabId: run.createdTabId,
					});
				return {
					kind: "failed",
					source: input.source,
					runId: input.runId,
					errorCode: input.code,
					effects,
				};
			});
		},
	};
}
