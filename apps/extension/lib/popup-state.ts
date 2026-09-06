/**
 * What the popup says, decided from persisted state alone.
 *
 * This exists because the popup used to render a message string the background
 * had written into storage, and a string is not a state: "running…" outlived
 * the run that wrote it, survived reloads and browser restarts, and left the
 * only honest answer to "is this working" reading as a permanent yes.
 *
 * So nothing here reads a message. It reads durable run records and durable
 * outbox counts, and the one rule that matters falls out of the ordering
 * below: a source cannot say it is synced while anything is still queued,
 * retrying or failed for it. Words that outlive their facts are the bug.
 */

import type { CaptureQueueStatus } from "@anansi/sources";

export type SourceStateName =
	| "disabled"
	| "running"
	| "stalled"
	| "sign_in_required"
	| "failed"
	| "retrying"
	| "queued"
	| "paused"
	| "synced"
	| "ready";

export type Tone = "accent" | "ok" | "warn" | "muted" | "faint";
export type SourceAction = "import" | "pause" | "none";

export interface SourceSnapshot {
	source: string;
	/** A source switched off in the web app is simply absent from the config. */
	enabled: boolean;
	phase: "idle" | "running";
	startedAt?: number;
	/** Last durable progress, used to distinguish a long import from a stall. */
	updatedAt?: number;
	paused?: boolean;
	/** Outbox counts belonging to this source, not the whole queue. */
	queue: CaptureQueueStatus;
	lastErrorCode?: string;
	lastErrorMessage?: string;
	lastRun?: number | null;
	/** How many items the library holds for this source. */
	held?: number;
}

/** Clear one popup-only start marker without mutating React's previous state. */
export function withoutStartingSource(sources: ReadonlySet<string>, source: string): Set<string> {
	const next = new Set(sources);
	next.delete(source);
	return next;
}

export interface SourceView {
	state: SourceStateName;
	text: string;
	tone: Tone;
	action: SourceAction;
	actionLabel: string;
	/** Nothing outstanding, nothing in flight. */
	settled: boolean;
}

/**
 * How long a run may go quiet before it is presumed dead.
 *
 * Judged from a timestamp rather than by a timer in the worker: MV3 kills an
 * idle service worker after about thirty seconds, so a watchdog there usually
 * never fires. A stored `startedAt` keeps working while nothing is running at
 * all, which is exactly when the question gets asked.
 */
export const RUN_TIMEOUT_MS = 90_000;

const SIGN_IN_CODES = new Set(["not_signed_in"]);

function pending(queue: CaptureQueueStatus): number {
	return queue.queued + queue.uploading;
}

export function isSettled(snapshot: SourceSnapshot): boolean {
	const { queue } = snapshot;
	return (
		snapshot.phase !== "running" &&
		queue.queued === 0 &&
		queue.uploading === 0 &&
		queue.retrying === 0 &&
		queue.failed === 0
	);
}

function plural(count: number, one: string, many: string): string {
	return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function syncedAt(at: number | null | undefined, now: number): string {
	if (!at) return "";
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return " · just now";
	if (minutes < 60) return ` · ${plural(minutes, "minute", "minutes")} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return ` · ${plural(hours, "hour", "hours")} ago`;
	return ` · ${plural(Math.floor(hours / 24), "day", "days")} ago`;
}

/**
 * One source's state, in the order that keeps it honest.
 *
 * Outstanding work is reported before anything reassuring, so "synced" is
 * unreachable while the outbox still holds something for this source.
 */
export function describeSource(
	snapshot: SourceSnapshot,
	now: number,
): SourceView {
	const { queue } = snapshot;
	const settled = isSettled(snapshot);

	if (!snapshot.enabled) {
		return {
			state: "disabled",
			text: "Switched off in Sources",
			tone: "faint",
			action: "none",
			actionLabel: "Import",
			settled,
		};
	}

	if (snapshot.phase === "running" && snapshot.startedAt) {
		if (now - (snapshot.updatedAt ?? snapshot.startedAt) < RUN_TIMEOUT_MS) {
			const held = pending(queue);
			return {
				state: "running",
				text: held > 0 ? `Importing · ${held} to send` : "Importing",
				tone: "accent",
				action: "pause",
				actionLabel: "Pause",
				settled: false,
			};
		}
		return {
			state: "stalled",
			text: "Stopped responding — press Import to try again",
			tone: "warn",
			action: "import",
			actionLabel: "Import",
			settled: false,
		};
	}

	if (snapshot.lastErrorCode && SIGN_IN_CODES.has(snapshot.lastErrorCode)) {
		return {
			state: "sign_in_required",
			text: "Session not detected — sign in, then try again",
			tone: "warn",
			action: "import",
			actionLabel: "Try again",
			settled,
		};
	}

	if (queue.failed > 0) {
		return {
			state: "failed",
			text: `${plural(queue.failed, "capture", "captures")} could not be sent`,
			tone: "warn",
			action: "import",
			actionLabel: "Import",
			settled: false,
		};
	}

	if (queue.retrying > 0) {
		return {
			state: "retrying",
			text: `Retrying ${plural(queue.retrying, "capture", "captures")}`,
			tone: "warn",
			action: "import",
			actionLabel: "Import",
			settled: false,
		};
	}

	if (pending(queue) > 0) {
		return {
			state: "queued",
			text: `${plural(pending(queue), "capture", "captures")} waiting to send`,
			tone: "muted",
			action: "import",
			actionLabel: "Import",
			settled: false,
		};
	}

	if (snapshot.paused) {
		return {
			state: "paused",
			text: "Paused — nothing was lost",
			tone: "muted",
			action: "import",
			actionLabel: "Resume",
			settled,
		};
	}

	if (snapshot.lastErrorCode) {
		return {
			state: "failed",
			text:
				snapshot.lastErrorCode === "rate_limited"
					? "Platform rate limit — retry later"
					: "Import failed — press Import to retry",
			tone: "warn",
			action: "import",
			actionLabel: "Import",
			settled,
		};
	}

	const held = snapshot.held ?? 0;
	if (held > 0) {
		return {
			state: "synced",
			text: `${held.toLocaleString()} saved${syncedAt(snapshot.lastRun, now)}`,
			tone: "faint",
			action: "import",
			actionLabel: "Import",
			settled,
		};
	}

	return {
		state: "ready",
		text: "Ready to import",
		tone: "muted",
		action: "import",
		actionLabel: "Import",
		settled,
	};
}

export interface QueueView {
	text: string;
	tone: Tone;
	canRetry: boolean;
	total: number;
}

/** The whole outbox in one line, shown only when it has something to say. */
export function describeQueue(queue: CaptureQueueStatus): QueueView {
	const waiting = pending(queue) + queue.retrying;
	const total = waiting + queue.failed;
	if (queue.failed > 0) {
		return {
			text:
				waiting > 0
					? `${queue.failed} failed · ${waiting} waiting`
					: `${plural(queue.failed, "capture", "captures")} failed`,
			tone: "warn",
			canRetry: true,
			total,
		};
	}
	return {
		text: `${waiting} waiting to send`,
		tone: "muted",
		canRetry: waiting > 0,
		total,
	};
}

/**
 * Make an error safe to show.
 *
 * Diagnostics are the one place a token can reach the screen and then a
 * screenshot, so anything shaped like a credential is removed rather than
 * trimmed, and a URL keeps its path but loses its query.
 */
export function redactError(message: string, limit = 180): string {
	const cleaned = message
		.replace(/\b[Bb]earer\s+\S+/g, "Bearer ***")
		.replace(
			/\b(token|authorization|cookie|ct0|csrf[-_]?token|api[-_]?key|secret|password)\b\s*[:=]\s*\S+/gi,
			"$1 ***",
		)
		.replace(/([?&][^=\s]+=)[^&\s]+/g, "$1***")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}
