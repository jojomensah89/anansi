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
		const text =
			runtime?.lastErrorCode === "not_signed_in"
				? "Sign in required"
				: `${plural(runtime?.failed ?? 1, "capture")} failed`;
		return { state: "failed", text, tone: "warn" };
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
		text: source.mode === "manual" ? "Right-click any page to clip" : "Ready",
		tone: "ok",
	};
}

export function extensionLabel(extension: ExtensionHealth): string {
	if (extension.connection === "never_connected")
		return "Extension never connected";
	if (extension.connection === "disconnected") return "Extension disconnected";
	return `Connected${extension.extensionVersion ? ` · v${extension.extensionVersion}` : ""}`;
}
