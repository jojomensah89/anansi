/**
 * The small confirmation beside a platform's own save button.
 *
 * It runs in the isolated world and renders inside a shadow root using text
 * content only, so nothing from the platform's page reaches it and the
 * platform's styles cannot change it.
 */
export type SaveAction = "save" | "unsave";
export type SaveOutcome = "stored" | "failed" | "disconnected";

interface Size {
	width: number;
	height: number;
}

const MARGIN = 8;
const GAP = 12;
const VISIBLE_MS = 1_600;
const ERROR_VISIBLE_MS = 4_000;

export function saveToastMessage(
	action: SaveAction,
	outcome: SaveOutcome,
): { text: string; tone: "ok" | "error" } {
	if (outcome === "stored") {
		return { text: action === "save" ? "Saved to Anansi" : "Removed from Anansi", tone: "ok" };
	}
	if (outcome === "disconnected") {
		return { text: "Connect Anansi to save this", tone: "error" };
	}
	return { text: action === "save" ? "Not saved to Anansi" : "Not removed from Anansi", tone: "error" };
}

export function toastPosition(
	pointer: { x: number; y: number } | null,
	viewport: Size,
	size: Size,
): { left: number; top: number } {
	const maxLeft = viewport.width - size.width - MARGIN;
	const maxTop = viewport.height - size.height - MARGIN;
	if (!pointer) return { left: maxLeft - 16, top: maxTop - 16 };
	const left = pointer.x - size.width / 2;
	const above = pointer.y - size.height - GAP;
	const top = above >= MARGIN ? above : pointer.y + GAP;
	return {
		left: Math.round(Math.min(maxLeft, Math.max(MARGIN, left))),
		top: Math.round(Math.min(maxTop, Math.max(MARGIN, top))),
	};
}

const STYLE = `
:host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
.toast {
	display: flex; align-items: center; gap: 8px; box-sizing: border-box;
	height: 32px; padding: 0 12px; border-radius: 8px;
	background: #19191b; color: #ededed;
	border: 1px solid rgba(237, 237, 237, 0.1);
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
	font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
	white-space: nowrap;
	animation: enter 120ms cubic-bezier(0.2, 0, 0, 1);
}
.dot { width: 6px; height: 6px; border-radius: 3px; background: #e4a33c; flex: none; }
.error .dot { background: #e5484d; }
@keyframes enter { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
`;

const ESTIMATED_SIZE: Size = { width: 208, height: 32 };

export interface SaveToastDependencies {
	document: Document;
	viewport: () => Size;
	schedule: (run: () => void, ms: number) => number;
	cancel: (id: number) => void;
}

export function createSaveToast(deps: SaveToastDependencies) {
	let host: HTMLElement | null = null;
	let timer: number | null = null;
	let pointer: { x: number; y: number } | null = null;

	const remove = () => {
		host?.remove();
		host = null;
		timer = null;
	};

	return {
		notePointer(x: number, y: number) {
			pointer = { x, y };
		},
		show(action: SaveAction, outcome: SaveOutcome) {
			if (timer !== null) deps.cancel(timer);
			host?.remove();

			const { text, tone } = saveToastMessage(action, outcome);
			const next = deps.document.createElement("div");
			next.setAttribute("data-anansi-toast", "");
			const root = next.attachShadow({ mode: "open" });

			const style = deps.document.createElement("style");
			style.textContent = STYLE;
			const toast = deps.document.createElement("div");
			toast.className = tone === "error" ? "toast error" : "toast";
			const dot = deps.document.createElement("span");
			dot.className = "dot";
			const label = deps.document.createElement("span");
			label.setAttribute("role", "status");
			label.textContent = text;
			toast.append(dot, label);
			root.append(style, toast);

			const place = (size: Size) => {
				const { left, top } = toastPosition(pointer, deps.viewport(), size);
				next.style.left = `${left}px`;
				next.style.top = `${top}px`;
			};
			place(ESTIMATED_SIZE);
			(deps.document.documentElement ?? deps.document.body).append(next);
			// The text sets the width, so center on the click using the real size.
			const measured = toast.getBoundingClientRect?.();
			if (measured?.width) place({ width: measured.width, height: measured.height });

			host = next;
			timer = deps.schedule(remove, tone === "error" ? ERROR_VISIBLE_MS : VISIBLE_MS);
		},
	};
}

/**
 * The action of a save that failed validation, so the person hears about it.
 * The nonce keeps unrelated page messages from showing a false failure, and
 * the only result is one of two fixed words.
 */
export function rejectedSaveAction(data: unknown, nonce: string): SaveAction | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.anansi !== "page-event" || message.action !== "bookmark" || message.nonce !== nonce) return null;
	return message.bookmarkAction === "save" || message.bookmarkAction === "unsave" ? message.bookmarkAction : null;
}

const NOT_CONNECTED = "connect to Anansi before capturing";

/**
 * Hand one native save to the worker, retrying until it is durable.
 *
 * A worker restart is routine, so one miss stays silent. A second miss tells
 * the person, and a later success corrects that message.
 */
export function deliverWithConfirmation(deps: {
	send: () => Promise<{ ok?: boolean; error?: string } | undefined>;
	notify: (outcome: SaveOutcome) => void;
	retryLater: (again: () => void) => void;
}): Promise<void> {
	let misses = 0;
	let last: SaveOutcome | null = null;
	const tell = (outcome: SaveOutcome) => {
		if (outcome === last) return;
		last = outcome;
		deps.notify(outcome);
	};
	const attempt = async (): Promise<void> => {
		try {
			const result = await deps.send();
			if (result?.ok) {
				tell("stored");
				return;
			}
			if (result?.error === NOT_CONNECTED) tell("disconnected");
			else if (++misses >= 2) tell("failed");
		} catch {
			if (++misses >= 2) tell("failed");
		}
		deps.retryLater(() => void attempt());
	};
	return attempt();
}
