import type { SyncStateRecord } from "./idb-outbox.ts";

export type CaptureSource = "x" | "reddit" | "tiktok" | "github" | "web";

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
}

export interface ActiveSourceRunState extends SourceRunState {
	phase: "running";
	runId: string;
	startedAt: number;
}

export interface SyncStateStore {
	getSyncState(source: string): Promise<SyncStateRecord | null>;
	putSyncState(state: SyncStateRecord): Promise<void>;
	deleteSyncState(source: string): Promise<void>;
}

export interface SourceRuns {
	begin(
		source: CaptureSource,
		mode?: "full" | "live",
	): Promise<{ started: boolean; run: ActiveSourceRunState }>;
	current(source: CaptureSource): Promise<SourceRunState>;
	capturePage(
		source: CaptureSource,
		page?: number,
	): Promise<{ runId: string; page: number; eventId: string }>;
	finish(source: CaptureSource): Promise<void>;
	stop(source: CaptureSource): Promise<number | null>;
	requestRefresh(source: CaptureSource): Promise<void>;
	claimRefresh(source: CaptureSource): Promise<boolean>;
	recordPendingSave(source: CaptureSource, externalId: string): Promise<void>;
	takePendingSaves(source: CaptureSource): Promise<string[]>;
	/** Advance the resume point. Only ever called after a page is queued. */
	setCursor(source: CaptureSource, cursor: string | null): Promise<void>;
	/** Remember whose profile to open, so the next Import goes straight there. */
	setHandle(source: CaptureSource, handle: string): Promise<void>;
	/** Record why a run ended badly, so the popup can offer the right fix. */
	noteError(source: CaptureSource, code: string): Promise<void>;
	initialImportDue(source: CaptureSource): Promise<boolean>;
	completeInitialImport(source: CaptureSource): Promise<void>;
	setOwnedTab(source: CaptureSource, tabId: number): Promise<void>;
	takeOwnedTab(
		source: CaptureSource,
		expectedTabId?: number,
	): Promise<number | null>;
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
	};
}

/** Enough to survive a burst of saves, not enough to become a second library. */
const MAX_PENDING_SAVES = 200;

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
	const tails = new Map<CaptureSource, Promise<void>>();

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
				const run: ActiveSourceRunState = {
					...current,
					phase: "running",
					runId: `${source}-${createId()}`,
					startedAt: now(),
					runMode: mode,
					nextPage: 0,
					// Starting again clears both, so neither outlives its run.
					paused: false,
					lastErrorCode: undefined,
					updatedAt: now(),
				};
				await write(run);
				return { started: true, run };
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

		finish(source) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({
					...current,
					phase: "idle",
					startedAt: undefined,
					runMode: undefined,
					updatedAt: now(),
				});
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
					paused: true,
					updatedAt: now(),
				});
				return tabId;
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

		takePendingSaves(source) {
			return serialize(source, async () => {
				const current = await read(source);
				if (current.pendingSaves.length === 0) return [];
				await write({ ...current, pendingSaves: [], updatedAt: now() });
				return current.pendingSaves;
			});
		},

		setOwnedTab(source, tabId) {
			return serialize(source, async () => {
				const current = await read(source);
				await write({ ...current, createdTabId: tabId, updatedAt: now() });
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
			if (
				host !== "github.com" ||
				url.pathname.replace(/\/+$/, "") !== "/stars" ||
				url.hash ||
				url.searchParams.size > 2
			) {
				return false;
			}
			return Array.from(url.searchParams).every(
				([key, parameter]) =>
					(key === "after" || key === "before" || key === "page") &&
					parameter.length <= 1_000,
			);
		}
		// TikTok has no favourites route to match: which profile counts depends
		// on who is signed in, and the tab has to be driven to the Favourites
		// tab once it is there. So a run always opens and closes its own tab
		// rather than taking over one you are using.
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
