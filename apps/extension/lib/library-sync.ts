/**
 * Checks platforms for saves made elsewhere, only when the library asks.
 *
 * There are no timers here on purpose. Opening the library on this computer
 * calls `libraryOpened`; opening it on another device reaches this through the
 * extension's check-in, as a `serverRequest`.
 */
export const SYNC_SKIP_MS = 5 * 60_000;
export const MAX_REQUEST_AGE_SECONDS = 10 * 60;
export const TIKTOK_SYNC_SETTING = "syncTiktok";
const LAST_CHECKS_KEY = "syncLastChecks";
const HANDLED_REQUEST_KEY = "syncHandledRequestAt";
const SYNC_SOURCES = ["x", "reddit", "github", "tiktok"] as const;

export type SyncSource = (typeof SYNC_SOURCES)[number];

export interface LibrarySyncDependencies {
	storage: {
		get(key: string): Promise<unknown>;
		set(values: Record<string, unknown>): Promise<void>;
	};
	now(): number;
	/** Sources the server currently has switched on. */
	enabledSources(): Promise<readonly string[]>;
	start(source: SyncSource): Promise<void>;
}

export function isLibraryPage(tabUrl: string | undefined, server: string | undefined): boolean {
	if (!tabUrl || !server) return false;
	try {
		const url = new URL(tabUrl);
		return url.origin === server && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/mcp");
	} catch {
		return false;
	}
}

export function createLibrarySync(dependencies: LibrarySyncDependencies) {
	const { storage, now, enabledSources, start } = dependencies;
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const next = tail.then(task, task);
		tail = next.catch(() => {});
		return next;
	};

	const run = async (only?: readonly string[], force = false): Promise<SyncSource[]> => {
		const enabled = new Set(await enabledSources());
		const checks = ((await storage.get(LAST_CHECKS_KEY)) ?? {}) as Partial<Record<SyncSource, number>>;
		const tiktok = (await storage.get(TIKTOK_SYNC_SETTING)) === true;
		const at = now();
		const due = SYNC_SOURCES.filter((source) => {
			if ((only && !only.includes(source)) || !enabled.has(source) || (source === "tiktok" && !tiktok)) return false;
			const last = checks[source];
			return force || last === undefined || last > at || at - last >= SYNC_SKIP_MS;
		});
		if (due.length === 0) return due;
		// Recorded first: a reload during a slow start must not open a second tab.
		await storage.set({
			[LAST_CHECKS_KEY]: { ...checks, ...Object.fromEntries(due.map((source) => [source, at])) },
		});
		await Promise.allSettled(due.map((source) => start(source)));
		return due;
	};

	return {
		libraryOpened: () => serial(() => run()),
		syncNow: () => serial(() => run(undefined, true)),
		platformRequests: (requests: unknown) => serial(async () => {
      if (!Array.isArray(requests) || requests.length > 4) return [];
      const started: SyncSource[] = [];
      for (const row of requests) {
        if (!row || !SYNC_SOURCES.includes(row.source) || !Number.isSafeInteger(row.requestedAt) || row.requestedAt > now() / 1000 + 60 || now() / 1000 - row.requestedAt > MAX_REQUEST_AGE_SECONDS) continue;
        const key = `syncHandled:${row.source}`;
        const handled = await storage.get(key);
        if (typeof handled === "number" && handled >= row.requestedAt) continue;
        await storage.set({[key]: row.requestedAt});
        started.push(...await run([row.source], row.forced === 1));
      }
      return started;
    }),
		serverRequest: (requestedAt: unknown) =>
			serial(async (): Promise<SyncSource[]> => {
				if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt)) return [];
				const handled = await storage.get(HANDLED_REQUEST_KEY);
				if (typeof handled === "number" && requestedAt <= handled) return [];
				await storage.set({ [HANDLED_REQUEST_KEY]: requestedAt });
				// A browser that was off should not act on yesterday's visit.
				if (now() / 1000 - requestedAt > MAX_REQUEST_AGE_SECONDS) return [];
				return run();
			}),
	};
}
