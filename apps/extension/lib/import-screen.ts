/**
 * The quiet screen over a tab Anansi opened to import someone's history.
 *
 * Without it the person watches X or TikTok being driven by hand, which looks
 * broken and invites clicking around. The screen sits on top of the page; the
 * page underneath keeps rendering and scrolling exactly as before.
 *
 * Everything here is pure or takes its browser calls as arguments, so the
 * decisions (which tabs, what it says) can be tested without a browser. The
 * worker owns the decisions; the relay content script only draws what it is
 * told.
 */

/** Only these sources drive a visible tab. Reddit and GitHub fetch without one. */
export type ImportScreenSource = "x" | "tiktok";

const SCREEN_SOURCES: readonly string[] = ["x", "tiktok"];

export type ImportScreenPhase = "running" | "done" | "failed";

/** What the relay is told to draw. Counts and codes only, never page content. */
export interface ImportScreenView {
	source: ImportScreenSource;
	phase: ImportScreenPhase;
	/** Saves accepted so far, summed from the run's own page messages. */
	items: number;
	/** The run's error code, when it failed. */
	errorCode?: string;
}

export interface ImportScreenCommand {
	anansi: "import-screen";
	action: "render";
	view: ImportScreenView;
}

export interface ImportScreenCloseRequest {
	anansi: "import-screen";
	action: "close";
}

/**
 * Whether a run's tab gets the screen.
 *
 * Only a tab Anansi opened itself, only for a history import, and only for a
 * source that drives a tab. A tab the person already had open, a live sync,
 * and ordinary browsing never see it.
 */
export function importScreenEligible(input: {
	source: string;
	owned: boolean;
	runMode: "full" | "live" | undefined;
}): input is { source: ImportScreenSource; owned: true; runMode: "full" } {
	return input.owned && input.runMode === "full" && SCREEN_SOURCES.includes(input.source);
}

const PLATFORM: Record<ImportScreenSource, { name: string; saves: string; frame: string }> = {
	x: { name: "X", saves: "bookmarks", frame: "tab" },
	tiktok: { name: "TikTok", saves: "favorites", frame: "window" },
};

function count(value: number): string {
	return value.toLocaleString("en-US");
}

function failureLine(source: ImportScreenSource, code: string | undefined): string {
	const { name } = PLATFORM[source];
	switch (code) {
		case "capture_timeout":
			return `The ${name} page stopped responding`;
		case "not_signed_in":
			return `Sign in to ${name} in this browser first`;
		case "platform_request_failed":
			return `${name} did not answer the import`;
		case "query_unavailable":
		case "page_shape_changed":
			return `${name} changed its page, so the import could not continue`;
		case "queue_full":
			return "Too many saves are waiting to upload";
		case "record_too_large":
		case "queue_failed":
			return "A page could not be stored, so the import stopped";
		default:
			return "The import stopped before the end";
	}
}

export interface ImportScreenCopy {
	/** The one line that says what is happening. */
	title: string;
	/** The live count, or null when there is none to show. */
	count: string | null;
	/** The muted line underneath. */
	note: string;
	/** Whether the small progress indicator runs. */
	busy: boolean;
	/** Only a failed import leaves the tab open, so only it has a button. */
	closeButton: boolean;
}

/** The words for one state of the screen. */
export function importScreenCopy(view: ImportScreenView): ImportScreenCopy {
	const platform = PLATFORM[view.source];
	const items = Number.isFinite(view.items) && view.items > 0 ? Math.floor(view.items) : 0;
	if (view.phase === "done") {
		return {
			title:
				items === 0
					? `No ${platform.saves} to import`
					: `Imported ${count(items)} ${items === 1 ? "save" : "saves"}`,
			count: null,
			note: `This ${platform.frame} closes in a moment`,
			busy: false,
			closeButton: false,
		};
	}
	if (view.phase === "failed") {
		return {
			title: failureLine(view.source, view.errorCode),
			count: items > 0 ? `${count(items)} saved before it stopped` : null,
			note: "Try again from Anansi in your toolbar",
			busy: false,
			closeButton: true,
		};
	}
	return {
		title: `Importing your ${platform.name} ${platform.saves}…`,
		count: items > 0 ? `${count(items)} saved so far` : null,
		note: `Keep this ${platform.frame} open. It closes by itself when the import finishes.`,
		busy: true,
		closeButton: false,
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The relay draws only a well-formed command from the worker. */
export function parseImportScreenCommand(value: unknown): ImportScreenView | null {
	if (!record(value) || value.anansi !== "import-screen" || value.action !== "render") return null;
	const view = value.view;
	if (!record(view)) return null;
	if (typeof view.source !== "string" || !SCREEN_SOURCES.includes(view.source)) return null;
	if (view.phase !== "running" && view.phase !== "done" && view.phase !== "failed") return null;
	if (typeof view.items !== "number" || !Number.isFinite(view.items) || view.items < 0) return null;
	if (view.errorCode !== undefined && (typeof view.errorCode !== "string" || view.errorCode.length > 64)) return null;
	return {
		source: view.source as ImportScreenSource,
		phase: view.phase,
		items: Math.floor(view.items),
		...(typeof view.errorCode === "string" ? { errorCode: view.errorCode } : {}),
	};
}

export function isImportScreenCloseRequest(value: unknown): value is ImportScreenCloseRequest {
	return record(value) && value.anansi === "import-screen" && value.action === "close";
}

/** How a run ended, read from its state once the lifecycle has finished it. */
export type ImportScreenEnding =
	| { kind: "completed" }
	| { kind: "stopped" }
	| { kind: "failed"; errorCode?: string };

export function importScreenEnding(run: {
	paused?: boolean;
	lastErrorCode?: string;
}): ImportScreenEnding {
	if (run.paused) return { kind: "stopped" };
	if (run.lastErrorCode) return { kind: "failed", errorCode: run.lastErrorCode };
	return { kind: "completed" };
}

/** Long enough to read "Imported 1,284 saves", short enough not to linger. */
export const IMPORT_SCREEN_DONE_MS = 1_600;

interface ScreenTab {
	source: ImportScreenSource;
	runId: string;
	items: number;
	phase: ImportScreenPhase;
	errorCode?: string;
	/** The relay drew at least once, so the person is looking at the screen. */
	shown: boolean;
}

export interface ImportScreensDependencies {
	/** Resolves true only if the tab's relay received the command. */
	send(tabId: number, command: ImportScreenCommand): Promise<boolean>;
	wait(ms: number): Promise<void>;
}

/**
 * The worker's side: which tabs show the screen and what each one says.
 *
 * Held in memory. A worker restart forgets it, and the tab then simply closes
 * the way it always did, so nothing depends on this surviving.
 */
export function createImportScreens(deps: ImportScreensDependencies) {
	const tabs = new Map<number, ScreenTab>();

	const draw = async (tabId: number, tab: ScreenTab): Promise<boolean> => {
		const delivered = await deps
			.send(tabId, {
				anansi: "import-screen",
				action: "render",
				view: {
					source: tab.source,
					phase: tab.phase,
					items: tab.items,
					...(tab.errorCode ? { errorCode: tab.errorCode } : {}),
				},
			})
			.catch(() => false);
		if (delivered) tab.shown = true;
		return delivered;
	};

	return {
		/** Cover a tab the run just opened, if it is one that gets the screen. */
		async open(input: {
			tabId: number;
			source: string;
			runId: string;
			owned: boolean;
			runMode: "full" | "live" | undefined;
		}): Promise<void> {
			if (!importScreenEligible(input)) return;
			const tab: ScreenTab = {
				source: input.source,
				runId: input.runId,
				items: 0,
				phase: "running",
				shown: false,
			};
			tabs.set(input.tabId, tab);
			await draw(input.tabId, tab);
		},

		/** A page of this run was durably accepted. */
		async progress(tabId: number | undefined, runId: string | undefined, items: number): Promise<void> {
			if (tabId === undefined) return;
			const tab = tabs.get(tabId);
			if (!tab || tab.runId !== runId || tab.phase !== "running") return;
			if (Number.isFinite(items) && items > 0) tab.items += Math.floor(items);
			await draw(tabId, tab);
		},

		/** The tab's relay loaded again (a navigation or reload); draw it again. */
		async reattach(tabId: number | undefined): Promise<void> {
			if (tabId === undefined) return;
			const tab = tabs.get(tabId);
			if (tab) await draw(tabId, tab);
		},

		/**
		 * Called just before the worker closes a tab it owns.
		 *
		 * A finished import shows its count briefly and then closes. A failed one
		 * stays open to say why, with a Close button. A stopped one closes at once:
		 * the person asked for that. A tab that never showed the screen closes the
		 * way it always did.
		 */
		async settle(tabId: number, runId: string, ending: ImportScreenEnding): Promise<"close" | "hold"> {
			const tab = tabs.get(tabId);
			if (!tab || tab.runId !== runId || !tab.shown) {
				tabs.delete(tabId);
				return "close";
			}
			if (ending.kind === "completed") {
				tab.phase = "done";
				tabs.delete(tabId);
				if (await draw(tabId, tab)) await deps.wait(IMPORT_SCREEN_DONE_MS);
				return "close";
			}
			if (ending.kind === "failed") {
				tab.phase = "failed";
				tab.errorCode = ending.errorCode;
				if (await draw(tabId, tab)) return "hold";
			}
			tabs.delete(tabId);
			return "close";
		},

		/** The person pressed Close on a failed screen. */
		closeRequested(tabId: number | undefined): { source: ImportScreenSource; runId: string } | null {
			if (tabId === undefined) return null;
			const tab = tabs.get(tabId);
			if (!tab || tab.phase !== "failed") return null;
			tabs.delete(tabId);
			return { source: tab.source, runId: tab.runId };
		},

		/** Forget a tab that is being closed for another reason. */
		forget(tabId: number | undefined): void {
			if (tabId !== undefined) tabs.delete(tabId);
		},
	};
}

export type ImportScreens = ReturnType<typeof createImportScreens>;
