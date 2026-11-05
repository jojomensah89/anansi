import type { ExtensionHealth, SourceRow } from "./api.ts";

export type SourceState =
	| "coming_next"
	| "disabled"
	| "disconnected"
	| "running"
	| "paused"
	| "failed"
	| "retrying"
	| "queued"
	| "experimental"
	| "ready";

export type SourceTone = "ok" | "accent" | "warn" | "muted" | "faint";

export interface SourcePresentation {
	state: SourceState;
	text: string;
	tone: SourceTone;
}

function plural(count: number, word: string): string {
	return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

const ERROR_TEXT: Record<string, string> = {
	not_signed_in: "Sign in required",
	queue_full: "Capture queue is full, delivery is catching up",
	rate_limited: "Rate limited, will retry later",
};

/** Say what went wrong; a count of zero failures is not a description. */
function failureText(runtime: SourceRow["runtime"]): string {
	const named = runtime?.lastErrorCode ? ERROR_TEXT[runtime.lastErrorCode] : undefined;
	if (named) return named;
	if (runtime && runtime.failed > 0) return `${plural(runtime.failed, "capture")} failed`;
	return "Last capture failed";
}

export function sourcePresentation(
	source: SourceRow,
	extension: ExtensionHealth,
): SourcePresentation {
	if (source.support === "coming_next") {
		return { state: "coming_next", text: "Coming next", tone: "faint" };
	}
	if (!source.enabled) {
		return { state: "disabled", text: "Capture turned off", tone: "faint" };
	}
	if (source.requiresExtension && extension.connection !== "connected") {
		return {
			state: "disconnected",
			text:
				extension.connection === "never_connected"
					? "Waiting for the extension"
					: "Extension disconnected",
			tone: "warn",
		};
	}

	const runtime = source.runtime;
	if (runtime?.phase === "running") {
		const waiting = runtime.queued + runtime.uploading;
		return {
			state: "running",
			text:
				waiting > 0
					? `Importing · ${plural(waiting, "capture")} to send`
					: "Importing",
			tone: "accent",
		};
	}
	if (runtime?.paused) {
		return { state: "paused", text: "Import paused", tone: "muted" };
	}
	if ((runtime?.failed ?? 0) > 0 || runtime?.lastErrorCode) {
		return { state: "failed", text: failureText(runtime), tone: "warn" };
	}
	if ((runtime?.retrying ?? 0) > 0) {
		return {
			state: "retrying",
			text: `Retrying ${plural(runtime?.retrying ?? 0, "capture")}`,
			tone: "warn",
		};
	}
	const waiting = (runtime?.queued ?? 0) + (runtime?.uploading ?? 0);
	if (waiting > 0) {
		return {
			state: "queued",
			text: `${plural(waiting, "capture")} waiting`,
			tone: "muted",
		};
	}
	if (source.support === "experimental") {
		return {
			state: "experimental",
			text: "Experimental · needs live verification",
			tone: "accent",
		};
	}
	return {
		state: "ready",
		text: source.mode === "manual" ? "Save a page or selection" : source.source === "tiktok" ? "Ready to import through the extension" : "Ready",
		tone: "ok",
	};
}

export function extensionLabel(extension: ExtensionHealth): string {
	if (extension.connection === "never_connected")
		return "Extension never connected";
	if (extension.connection === "disconnected") return "Extension disconnected";
	return `Connected${extension.extensionVersion ? ` · v${extension.extensionVersion}` : ""}`;
}
