import type { ShippedCaptureSource } from "@anansi/sources";
import type { SyncStateRecord } from "./idb-outbox.ts";
import { validatedGitHubStarsPageUrl } from "./platforms/github.ts";

/** Current extension capture identities, including manual Web capture. */
export type CaptureSource = ShippedCaptureSource;

export interface SourceRunState extends SyncStateRecord {
	source: CaptureSource;
	phase: "idle" | "running";
	runId?: string;
	startedAt?: number;
	nextPage: number;
	pendingRefresh: boolean;
	/**
	 * Saves seen live that still need their content.
	 *
	 * A platform tells you that something was bookmarked long before it tells
	 * you what: X's CreateBookmark answers `{"tweet_bookmark_put":"Done"}`. So
	 * the id waits here while a refresh fetches the post, and the save event is
	 * only sent once those pages are queued ahead of it — a save for an item
	 * the server has never seen is a permanent failure, not a retry.
	 */
	pendingSaves: string[];
	/** The signed-in handle, once a page has told us one. */
	handle?: string;
	/** Stopped by hand. Progress is kept; nothing queued is discarded. */
	paused?: boolean;
	/** The last thing the page said went wrong, as a code rather than prose. */
	lastErrorCode?: string;
	/** Set only after the one-time history walk reaches its genuine end. */
	initialImportCompletedAt?: number;
	/** Whether this run is a history walk or a one-page live refresh. */
	runMode?: "full" | "live";
	/** Durable identity source for precise item events that may share a second. */
	itemEventSequence: number;
	/** The tab currently driving the run; it is not necessarily owned by Anansi. */
	activeTabId?: number;
}

export interface ActiveSourceRunState extends SourceRunState {
	phase: "running";
	runId: string;
	startedAt: number;
}

export interface SyncStateStore {
	/** Optional same-realm identity for adapter instances sharing one store. */
	readonly coordinationKey?: object;
	getSyncState(source: string): Promise<SyncStateRecord | null>;
	putSyncState(state: SyncStateRecord): Promise<void>;
	deleteSyncState(source: string): Promise<void>;
}

export interface SourceRuns {
	begin(
		source: CaptureSource,
		mode?: "full" | "live",
	): Promise<{
		started: boolean;
		run: ActiveSourceRunState;
		/** A previous expired run's owned tab must not be inherited by a replacement. */
		replacedOwnedTabId?: number;
		/** Run that owned the replacement tab, for run-fenced cleanup. */
		replacedRunId?: string;
	}>;
	current(source: CaptureSource): Promise<SourceRunState>;
	capturePage(
		source: CaptureSource,
		page?: number,
	): Promise<{ runId: string; page: number; eventId: string }>;
	/** Capture identity only if this is still the active run. */
	capturePageForRun(
		source: CaptureSource,
		runId: string,
		page?: number,
	): Promise<{ runId: string; page: number; eventId: string } | null>;
	finish(source: CaptureSource): Promise<void>;
	/** Run-id fenced completion; late callbacks cannot finish a replacement run. */
	finishForRun(source: CaptureSource, runId: string): Promise<boolean>;
	stop(source: CaptureSource): Promise<number | null>;
	/** Run-id fenced stop; preserves queued captures and returns the owned tab. */
	stopForRun(
		source: CaptureSource,
		runId: string,
	): Promise<{ stopped: boolean; tabId: number | null }>;
	requestRefresh(source: CaptureSource): Promise<void>;
	claimRefresh(source: CaptureSource): Promise<boolean>;
	recordPendingSave(source: CaptureSource, externalId: string): Promise<void>;
	/** Read held saves without releasing them; each item is acknowledged separately. */
	takePendingSaves(source: CaptureSource): Promise<string[]>;
	/** Remove one held save only after its precise event is durably queued. */
	ackPendingSave(source: CaptureSource, externalId: string): Promise<boolean>;
	/** Run a browser effect while its source identity is fenced by the same lock as state writes. */
	runIfCurrent(
		source: CaptureSource,
		expectedRunId: string | undefined,
		work: (run: SourceRunState) => Promise<void>,
	): Promise<boolean>;
	/** Advance the resume point. Only ever called after a page is queued. */
	setCursor(source: CaptureSource, cursor: string | null): Promise<void>;
	/** Cursor write fenced to the run that durably acknowledged its page. */
	setCursorForRun(
		source: CaptureSource,
		runId: string,
		cursor: string | null,
	): Promise<boolean>;
	/** Remember whose profile to open, so the next Import goes straight there. */
	setHandle(source: CaptureSource, handle: string): Promise<void>;
	/** Record why a run ended badly, so the popup can offer the right fix. */
	noteError(source: CaptureSource, code: string): Promise<void>;
	/** Run-id fenced error note; stale callbacks cannot annotate a replacement. */
	noteErrorForRun(
		source: CaptureSource,
		runId: string,
		code: string,
	): Promise<boolean>;
	initialImportDue(source: CaptureSource): Promise<boolean>;
	completeInitialImport(source: CaptureSource): Promise<void>;
	completeInitialImportForRun(
		source: CaptureSource,
		runId: string,
	): Promise<boolean>;
	nextItemEventSequence(source: CaptureSource): Promise<number>;
	setOwnedTab(source: CaptureSource, tabId: number): Promise<void>;
	/** Run-id fenced ownership assignment; stale starts cannot claim a new tab. */
	setOwnedTabForRun(
		source: CaptureSource,
		runId: string,
		tabId: number,
	): Promise<boolean>;
	/** Read-only run-fenced check used before applying a browser close effect. */
	isOwnedTabForRun(
		source: CaptureSource,
		runId: string,
		expectedTabId?: number,
	): Promise<boolean>;
	/** Record the tab delivering page events without claiming ownership. */
	setActiveTab(
		source: CaptureSource,
		runId: string,
		tabId: number,
	): Promise<boolean>;
	takeOwnedTab(
		source: CaptureSource,
		expectedTabId?: number,
	): Promise<number | null>;
	/** Take ownership only while the run that created the tab is still current. */
	takeOwnedTabForRun(
		source: CaptureSource,
		runId: string,
		expectedTabId?: number,
	): Promise<number | null>;
	/** Close an owned tab while its ownership fence remains held. */
	closeOwnedTabForRun(
		source: CaptureSource,
		runId: string,
		expectedTabId: number | undefined,
		close: (tabId: number) => Promise<void>,
	): Promise<boolean>;
	/** Dispose a newly opened tab only while no replacement run has claimed it. */
	disposeUnclaimedTab(
		source: CaptureSource,
		runId: string,
		tabId: number,
		dispose: () => Promise<void>,
	): Promise<boolean>;
}

export interface SourceRunsDependencies {
	store: SyncStateStore;
	now: () => number;
	createId: () => string;
}

function defaultState(source: CaptureSource, now: number): SourceRunState {
	return {
		source,
		phase: "idle",
		nextPage: 0,
		pendingRefresh: false,
		pendingSaves: [],
		itemEventSequence: 0,
		updatedAt: now,
	};
}

function asRunState(
	value: SyncStateRecord | null,
	source: CaptureSource,
	now: number,
): SourceRunState {
	if (!value) return defaultState(source, now);
	return {
		...defaultState(source, now),
		...value,
		source,
		phase: value.phase === "running" ? "running" : "idle",
		nextPage:
			typeof value.nextPage === "number" && Number.isSafeInteger(value.nextPage)
				? value.nextPage
				: 0,
		pendingRefresh: value.pendingRefresh === true,
		pendingSaves: Array.isArray(value.pendingSaves)
			? value.pendingSaves.filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				)
			: [],
		initialImportCompletedAt:
			typeof value.initialImportCompletedAt === "number" &&
			Number.isSafeInteger(value.initialImportCompletedAt) &&
			value.initialImportCompletedAt > 0
				? value.initialImportCompletedAt
				: undefined,
		runMode:
			value.runMode === "live"
				? "live"
				: value.runMode === "full"
					? "full"
					: undefined,
		itemEventSequence:
			typeof value.itemEventSequence === "number" &&
			Number.isSafeInteger(value.itemEventSequence) &&
			value.itemEventSequence >= 0
				? value.itemEventSequence
				: 0,
		activeTabId:
			typeof value.activeTabId === "number" &&
			Number.isSafeInteger(value.activeTabId) &&
			value.activeTabId > 0
				? value.activeTabId
				: undefined,
		orphanedTabId:
			typeof value.orphanedTabId === "number" &&
			Number.isSafeInteger(value.orphanedTabId) &&
			value.orphanedTabId > 0
				? value.orphanedTabId
				: undefined,
		orphanedTabRunId:
			typeof value.orphanedTabRunId === "string" &&
			value.orphanedTabRunId.length > 0
				? value.orphanedTabRunId
				: undefined,
	};
}

/** Enough to survive a burst of saves, not enough to become a second library. */
const MAX_PENDING_SAVES = 200;

/** Same-realm tails keyed by the underlying store, not by one adapter object. */
const sharedTails = new WeakMap<object, Map<CaptureSource, Promise<void>>>();

/**
 * A running import owns this lease. Chrome may terminate an MV3 worker without
 * running cleanup, so a persisted run older than the lease is recoverable by
 * the next worker instead of blocking imports forever.
 */
export const SOURCE_RUN_LEASE_MS = 90_000;

/** Durable source-run coordinator backed by the IndexedDB syncState store. */
export function createSourceRuns(
	dependencies: SourceRunsDependencies,
): SourceRuns {
	const { store, now, createId } = dependencies;
	const coordinationKey = store.coordinationKey ?? store;
	const tails =
		sharedTails.get(coordinationKey) ?? new Map<CaptureSource, Promise<void>>();
	sharedTails.set(coordinationKey, tails);

	const serialize = <T>(
		source: CaptureSource,
		work: () => Promise<T>,
	): Promise<T> => {
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

	const read = async (source: CaptureSource) =>
		asRunState(await store.getSyncState(source), source, now());
	const write = (state: SourceRunState) => store.putSyncState(state);

	return {
		begin(source, mode = "full") {
			return serialize(source, async () => {
				const current = await read(source);
				if (
					current.phase === "running" &&
					current.runId &&
					current.startedAt &&
					now() - current.updatedAt < SOURCE_RUN_LEASE_MS
				) {
					return {
						started: false,
						run: current as ActiveSourceRunState,
					};
				}
				const replacedOwnedTabId =
					current.createdTabId ?? current.orphanedTabId;
				const replacedRunId =
					current.createdTabId !== undefined
						? current.runId
						: current.orphanedTabRunId;
				const run: ActiveSourceRunState = {
					...current,
					phase: "running",
					runId: `${source}-${createId()}`,
					startedAt: now(),
					runMode: mode,
					nextPage: 0,
					// A replacement never inherits the previous driver tab.
					paused: false,
					lastErrorCode: undefined,
					createdTabId: undefined,
					activeTabId: undefined,
					...(replacedOwnedTabId !== undefined
						? {
								orphanedTabId: replacedOwnedTabId,
								orphanedTabRunId: replacedRunId,
							}
						: {}),
					updatedAt: now(),
				};
				await write(run);
				return {
					started: true,
					run,
					...(replacedOwnedTabId !== undefined ? { replacedOwnedTabId } : {}),
					...(replacedRunId !== undefined ? { replacedRunId } : {}),
				};
			});
		},

		current(source) {
			return serialize(source, () => read(source));
		},

		capturePage(source, requestedPage) {
			return serialize(source, async () => {
				const current = await read(source);
				const runId = current.runId ?? `${source}-${createId()}`;
				const page =
					requestedPage &&
					Number.isSafeInteger(requestedPage) &&
					requestedPage > 0
						? requestedPage
						: current.nextPage + 1;
				await write({
					...current,
					runId,
					nextPage: Math.max(current.nextPage, page),
					updatedAt: now(),
				});
				return { runId, page, eventId: `${runId}:page:${page}` };
			});
		},

		capturePageForRun(source, expectedRunId, requestedPage) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return null;
				const page =
					requestedPage &&
					Number.isSafeInteger(requestedPage) &&
					requestedPage > 0
						? requestedPage
						: current.nextPage + 1;
				await write({
					...current,
					nextPage: Math.max(current.nextPage, page),
					updatedAt: now(),
				});
				return {
					runId: expectedRunId,
					page,
					eventId: `${expectedRunId}:page:${page}`,
				};
			});
		},

		finish(source) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({
					...current,
					phase: "idle",
					startedAt: undefined,
					runMode: undefined,
					createdTabId: undefined,
					activeTabId: undefined,
					updatedAt: now(),
				});
			});
		},

		finishForRun(source, expectedRunId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				await write({
					...current,
					phase: "idle",
					startedAt: undefined,
					runMode: undefined,
					activeTabId: undefined,
					updatedAt: now(),
				});
				return true;
			});
		},

		stop(source) {
			return serialize(source, async () => {
				const current = await read(source);
				const tabId = current.createdTabId ?? null;
				await write({
					...current,
					phase: "idle",
					startedAt: undefined,
					runMode: undefined,
					createdTabId: undefined,
					activeTabId: undefined,
					paused: true,
					updatedAt: now(),
				});
				return tabId;
			});
		},

		stopForRun(source, expectedRunId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return { stopped: false, tabId: null };
				const tabId = current.createdTabId ?? null;
				await write({
					...current,
					phase: "idle",
					startedAt: undefined,
					runMode: undefined,
					// Keep ownership until the browser applies the close effect.
					activeTabId: undefined,
					paused: true,
					updatedAt: now(),
				});
				return { stopped: true, tabId };
			});
		},

		requestRefresh(source) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.pendingRefresh) return;
				await write({ ...current, pendingRefresh: true, updatedAt: now() });
			});
		},

		claimRefresh(source) {
			return serialize(source, async () => {
				const current = await read(source);
				if (!current.pendingRefresh || current.phase === "running")
					return false;
				await write({ ...current, pendingRefresh: false, updatedAt: now() });
				return true;
			});
		},

		recordPendingSave(source, externalId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.pendingSaves.includes(externalId)) return;
				// Oldest first out, so a flood loses the stale end rather than
				// the save that just happened.
				const pendingSaves = [...current.pendingSaves, externalId].slice(
					-MAX_PENDING_SAVES,
				);
				await write({ ...current, pendingSaves, updatedAt: now() });
			});
		},

		noteError(source, code) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({ ...current, lastErrorCode: code, updatedAt: now() });
			});
		},

		noteErrorForRun(source, expectedRunId, code) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				await write({ ...current, lastErrorCode: code, updatedAt: now() });
				return true;
			});
		},

		initialImportDue(source) {
			return serialize(source, async () => {
				const current = await read(source);
				return current.initialImportCompletedAt === undefined;
			});
		},

		completeInitialImport(source) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.initialImportCompletedAt !== undefined) return;
				await write({
					...current,
					initialImportCompletedAt: now(),
					updatedAt: now(),
				});
			});
		},

		completeInitialImportForRun(source, expectedRunId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				if (current.initialImportCompletedAt !== undefined) return true;
				await write({
					...current,
					initialImportCompletedAt: now(),
					updatedAt: now(),
				});
				return true;
			});
		},

		setHandle(source, handle) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.handle === handle) return;
				await write({ ...current, handle, updatedAt: now() });
			});
		},

		setCursor(source, cursor) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({
					...current,
					cursor: cursor ?? undefined,
					updatedAt: now(),
				});
			});
		},

		setCursorForRun(source, expectedRunId, cursor) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				await write({
					...current,
					cursor: cursor ?? undefined,
					updatedAt: now(),
				});
				return true;
			});
		},

		takePendingSaves(source) {
			return serialize(source, async () => {
				const current = await read(source);
				return current.pendingSaves;
			});
		},

		ackPendingSave(source, externalId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (!current.pendingSaves.includes(externalId)) return false;
				await write({
					...current,
					pendingSaves: current.pendingSaves.filter((id) => id !== externalId),
					updatedAt: now(),
				});
				return true;
			});
		},

		runIfCurrent(source, expectedRunId, work) {
			return serialize(source, async () => {
				const current = await read(source);
				const matches = expectedRunId
					? current.runId === expectedRunId
					: current.phase !== "running";
				if (!matches) return false;
				await work(current);
				return true;
			});
		},

		nextItemEventSequence(source) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.itemEventSequence >= Number.MAX_SAFE_INTEGER) {
					throw new Error("item event sequence exhausted");
				}
				const itemEventSequence = current.itemEventSequence + 1;
				await write({ ...current, itemEventSequence, updatedAt: now() });
				return itemEventSequence;
			});
		},

		setOwnedTab(source, tabId) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({ ...current, createdTabId: tabId, updatedAt: now() });
			});
		},

		setOwnedTabForRun(source, expectedRunId, tabId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				await write({ ...current, createdTabId: tabId, updatedAt: now() });
				return true;
			});
		},

		isOwnedTabForRun(source, expectedRunId, expectedTabId) {
			return serialize(source, async () => {
				const current = await read(source);
				const currentRunOwns =
					current.runId === expectedRunId &&
					current.createdTabId !== undefined &&
					(expectedTabId === undefined ||
						current.createdTabId === expectedTabId);
				if (currentRunOwns) return true;
				return (
					current.orphanedTabRunId === expectedRunId &&
					current.orphanedTabId !== undefined &&
					(expectedTabId === undefined ||
						current.orphanedTabId === expectedTabId) &&
					current.activeTabId !== current.orphanedTabId &&
					current.createdTabId !== current.orphanedTabId
				);
			});
		},

		setActiveTab(source, expectedRunId, tabId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.phase !== "running" || current.runId !== expectedRunId)
					return false;
				await write({ ...current, activeTabId: tabId, updatedAt: now() });
				return true;
			});
		},

		takeOwnedTab(source, expectedTabId) {
			return serialize(source, async () => {
				const current = await read(source);
				if (
					current.createdTabId === undefined ||
					(expectedTabId !== undefined &&
						current.createdTabId !== expectedTabId)
				) {
					return null;
				}
				const tabId = current.createdTabId;
				await write({ ...current, createdTabId: undefined, updatedAt: now() });
				return tabId;
			});
		},

		takeOwnedTabForRun(source, expectedRunId, expectedTabId) {
			return serialize(source, async () => {
				const current = await read(source);
				const currentRunOwns =
					current.runId === expectedRunId &&
					current.createdTabId !== undefined &&
					(expectedTabId === undefined ||
						current.createdTabId === expectedTabId);
				const orphanOwns =
					current.orphanedTabRunId === expectedRunId &&
					current.orphanedTabId !== undefined &&
					(expectedTabId === undefined ||
						current.orphanedTabId === expectedTabId) &&
					current.activeTabId !== current.orphanedTabId &&
					current.createdTabId !== current.orphanedTabId;
				if (!currentRunOwns && !orphanOwns) return null;
				const tabId = currentRunOwns
					? current.createdTabId
					: current.orphanedTabId;
				if (tabId === undefined) return null;
				await write({
					...current,
					...(currentRunOwns
						? { createdTabId: undefined }
						: {
								orphanedTabId: undefined,
								orphanedTabRunId: undefined,
							}),
					updatedAt: now(),
				});
				return tabId;
			});
		},

		closeOwnedTabForRun(
			source,
			expectedRunId,
			expectedTabId,
			close,
		) {
			return serialize(source, async () => {
				const current = await read(source);
				const currentRunOwns =
					current.runId === expectedRunId &&
					current.createdTabId !== undefined &&
					(expectedTabId === undefined ||
						current.createdTabId === expectedTabId);
				const orphanOwns =
					current.orphanedTabRunId === expectedRunId &&
					current.orphanedTabId !== undefined &&
					(expectedTabId === undefined ||
						current.orphanedTabId === expectedTabId) &&
					current.activeTabId !== current.orphanedTabId &&
					current.createdTabId !== current.orphanedTabId;
				if (!currentRunOwns && !orphanOwns) return false;
				const tabId = currentRunOwns
					? current.createdTabId
					: current.orphanedTabId;
				if (tabId === undefined) return false;
				// Keep begin/bind behind the browser close. Otherwise a replacement
				// can reuse this tab after ownership is taken but before remove().
				await close(tabId);
				await write({
					...current,
					...(currentRunOwns
						? { createdTabId: undefined }
						: {
								orphanedTabId: undefined,
								orphanedTabRunId: undefined,
							}),
					updatedAt: now(),
				});
				return true;
			});
		},

		disposeUnclaimedTab(source, expectedRunId, tabId, dispose) {
			return serialize(source, async () => {
				const current = await read(source);
				const replacementUsesTab =
					current.activeTabId === tabId ||
					current.createdTabId === tabId ||
					current.orphanedTabId === tabId;
				if (replacementUsesTab) return false;
				// The callback runs under the same source lock as begin/bind, so a
				// replacement cannot claim this tab between the check and remove.
				await dispose();
				return true;
			});
		},
	};
}

export function isExpectedImportTab(
	source: CaptureSource,
	value: string,
): boolean {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		if (source === "x") {
			return (
				(host === "x.com" || host === "twitter.com") &&
				url.pathname.replace(/\/+$/, "") === "/i/bookmarks"
			);
		}
		if (source === "reddit") {
			return (
				(host === "reddit.com" || host.endsWith(".reddit.com")) &&
				/^\/user\/[^/]+\/saved\/?$/.test(url.pathname)
			);
		}
		if (source === "github") {
			return (
				host === "github.com" &&
				validatedGitHubStarsPageUrl(value, value) !== null
			);
		}
		return false;
	} catch {
		return false;
	}
}

/** One source selects one delivery owner; there is no dual-write state. */
export function captureDeliveryMode(
	protocolVersion: number | undefined,
	flags: Partial<Record<CaptureSource, boolean>> | undefined,
	source: CaptureSource,
): "queue" | "legacy" {
	return protocolVersion === 2 && flags?.[source] === true ? "queue" : "legacy";
}
