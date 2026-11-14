/**
 * The words and the one action on each source row.
 *
 * `describeSource` decides the state from persisted records; this only turns
 * that state into what a row shows. A row has one action, and its label says
 * exactly what pressing it does:
 *
 * - "Pause" while a run is in flight
 * - "Try again" after something went wrong
 * - "Resume" after a pause
 * - no action for a source whose history is already in
 * - no action at all while this source's first import is due: the popup's
 *   one "Import all" button above the list starts that batch, and the row only
 *   says where it stands
 *
 * Status text never carries instructions the button already gives.
 *
 * A toggleable source also has a capture switch at the row's end. A source
 * switched off shows no action and no status: the switch already says it.
 */
import type { SourceView } from "./popup-state.ts";

export type RowTone = "default" | "active" | "warn" | "muted";
export type RowActionKind = "pause" | "import" | "none";

/** The capture switch at the end of a row. */
export interface SourceSwitchView {
	checked: boolean;
	disabled: boolean;
	/** Accessible name, e.g. "Capture TikTok". */
	label: string;
}

export interface SourceRowView {
	status: string;
	tone: RowTone;
	action: RowActionKind;
	label: string;
	/** Shown on the button while the start is being confirmed. */
	busyLabel: string;
	/** Null for a source that is always on. */
	switch: SourceSwitchView | null;
}

export interface SourceRowInput {
	view: SourceView;
	name: string;
	/** Configured, enabled, and its initial import has not completed. */
	initialImportDue: boolean;
	lastErrorCode?: string;
	/** Captures for this source the outbox gave up on. */
	queueFailed?: number;
	/** Progress of the run in flight, from the worker's status record. */
	progress?: { pages: number; items: number };
	/** The server config could not be read, so nothing can be started. */
	offline?: boolean;
	/** Whether the source can be switched off at all. */
	toggleable?: boolean;
	/**
	 * What the switch shows: the server's answer, the optimistic flip while a
	 * request is out, or the last known state when the server can't be reached.
	 */
	enabled?: boolean;
	/** A switch request is in flight. */
	switching?: boolean;
	/** The last switch request failed and the switch was put back. */
	switchFailed?: boolean;
}

/** The one action above the list that starts every due first import. */
export const IMPORT_ALL = "Import all";

/**
 * The line above Connect, shown before Chrome's permission prompt appears.
 * Null once Chrome already grants the library's origin, since no prompt follows.
 */
export function permissionPromptLine(origin: string | null, alreadyGranted: boolean): string | null {
	if (!origin || alreadyGranted) return null;
	try {
		return `Chrome will ask to let Anansi reach your library at ${new URL(origin).host}`;
	} catch {
		return null;
	}
}

function count(value: number): string {
	return value.toLocaleString("en-US");
}

function failureText(code: string | undefined, name: string, fallback: string): string {
	switch (code) {
		case "rate_limited":
			return `Rate limited by ${name}`;
		case "capture_timeout":
			return "Stalled. Keep its window visible";
		case "capture_failed":
			return "Stopped before the end";
		case undefined:
			return fallback;
		default:
			return "Import failed";
	}
}

export function sourceRowView(input: SourceRowInput): SourceRowView {
	const row = rowBody(input);
	const enabled = input.enabled ?? input.view.state !== "disabled";
	const toggle: SourceSwitchView | null = input.toggleable
		? { checked: enabled, disabled: Boolean(input.offline || input.switching), label: `Capture ${input.name}` }
		: null;
	if (input.switchFailed && !input.offline) {
		// The switch is already back where it was; say only that the change didn't take.
		return { ...row, status: enabled ? "Couldn't turn off" : "Couldn't turn on", tone: "warn", switch: toggle };
	}
	return { ...row, switch: toggle };
}

const NO_ACTION: Omit<SourceRowView, "status" | "tone" | "switch"> = { action: "none", label: "", busyLabel: "" };

function rowBody(input: SourceRowInput): Omit<SourceRowView, "switch"> {
	const { view, name, initialImportDue, offline } = input;
	// Without the server config nothing can start; the connection notice says why.
	if (offline) return { status: "", tone: "muted", ...NO_ACTION };
	// A switched-off row is just its name and its switch. A row being switched
	// on waits for the server's config before offering an import it might refuse.
	if (input.enabled === false || view.state === "disabled")
		return { status: "", tone: "muted", ...NO_ACTION };
	const importing: Pick<SourceRowView, "action" | "label" | "busyLabel"> = {
		action: "import",
		label: "Import",
		busyLabel: "Starting…",
	};
	// The first import of every due source is started by the list's one button.
	const idle: Pick<SourceRowView, "action" | "label" | "busyLabel"> = NO_ACTION;
	const retry: Pick<SourceRowView, "action" | "label" | "busyLabel"> = {
		action: "import",
		label: "Try again",
		busyLabel: "Starting…",
	};

	switch (view.state) {
		case "running": {
			const pages = input.progress?.pages ?? 0;
			const items = input.progress?.items ?? 0;
			const status = pages > 0 || items > 0 ? `${count(pages)} scanned, ${count(items)} new` : "Importing";
			return { status, tone: "active", action: "pause", label: "Pause", busyLabel: "Pausing…" };
		}
		case "stalled":
			return { status: "Stopped responding", tone: "warn", ...retry };
		case "sign_in_required":
			return { status: `Sign in to ${name} first`, tone: "warn", ...retry };
		case "failed":
			return {
				status: (input.queueFailed ?? 0) > 0 ? view.text : failureText(input.lastErrorCode, name, view.text),
				tone: "warn",
				...retry,
			};
		case "retrying":
			return { status: view.text, tone: "warn", ...idle };
		case "queued":
			return { status: view.text, tone: "muted", ...idle };
		case "paused":
			return { status: "Paused. Nothing was lost", tone: "muted", ...importing, label: "Resume", busyLabel: "Resuming…" };
		case "synced":
			return { status: view.text, tone: "muted", ...idle };
		case "ready":
			return {
				status: initialImportDue ? "Not imported yet" : "Ready to import",
				tone: "muted",
				...idle,
			};
	}
}
