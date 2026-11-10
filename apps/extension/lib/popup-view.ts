/**
 * The words and the one action on each source row.
 *
 * `describeSource` decides the state from persisted records; this only turns
 * that state into what a row shows. A row has one action, and its label says
 * exactly what pressing it does:
 *
 * - "Pause" while a run is in flight
 * - "Import everything" while this source's history has never finished
 *   importing (the popup used to say both "Import all history" and "Import
 *   remaining history" for this one action)
 * - "Try again" after something went wrong
 * - "Resume" after a pause
 * - "Import" otherwise
 *
 * Status text never carries instructions the button already gives.
 */
import type { SourceView } from "./popup-state.ts";

export type RowTone = "default" | "active" | "warn" | "muted";
export type RowActionKind = "pause" | "import" | "none";

export interface SourceRowView {
	status: string;
	tone: RowTone;
	action: RowActionKind;
	label: string;
	/** Shown on the button while the start is being confirmed. */
	busyLabel: string;
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
}

export const IMPORT_EVERYTHING = "Import everything";

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
	const { view, name, initialImportDue, offline } = input;
	// Without the server config nothing can start; the connection notice says why.
	if (offline) return { status: "", tone: "muted", action: "none", label: "", busyLabel: "" };
	const importLabel = initialImportDue ? IMPORT_EVERYTHING : "Import";
	const importing: Pick<SourceRowView, "action" | "label" | "busyLabel"> = {
		action: "import",
		label: importLabel,
		busyLabel: "Starting…",
	};
	const retry: Pick<SourceRowView, "action" | "label" | "busyLabel"> = {
		action: "import",
		label: "Try again",
		busyLabel: "Starting…",
	};

	switch (view.state) {
		case "disabled":
			return { status: "Off in Sources", tone: "muted", action: "none", label: "", busyLabel: "" };
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
			return { status: view.text, tone: "warn", ...importing };
		case "queued":
			return { status: view.text, tone: "muted", ...importing };
		case "paused":
			return { status: "Paused. Nothing was lost", tone: "muted", ...importing, label: "Resume", busyLabel: "Resuming…" };
		case "synced":
			return { status: view.text, tone: "muted", ...importing };
		case "ready":
			return {
				status: initialImportDue ? "History not imported yet" : "Ready to import",
				tone: "muted",
				...importing,
			};
	}
}
