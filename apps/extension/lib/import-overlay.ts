/**
 * The screen itself, drawn by the relay over a tab Anansi opened to import.
 *
 * It is one fixed, opaque layer in a closed shadow root, appended to <html>.
 * The page underneath is never hidden, faded or resized: X and TikTok keep
 * rendering, their scroll and intersection observers keep firing, and the
 * import's own scrolling is programmatic, so covering the page changes
 * nothing it relies on. Intersection observers measure geometry, not what is
 * painted on top, which is why an opaque cover is safe where fading the page
 * would not be. Only the person's own input is caught: clicks, wheel and keys
 * land on the screen, not on the platform behind it.
 *
 * Text content only. Nothing from the page reaches it, and the page's styles
 * cannot reach into it.
 */
import type { ImportScreenCopy } from "./import-screen.ts";

const TAG = "anansi-import-screen";

const HOST_STYLE = [
	"all: initial",
	"position: fixed",
	"inset: 0",
	"width: 100%",
	"height: 100%",
	"display: block",
	"z-index: 2147483647",
	"pointer-events: auto",
]
	.map((rule) => `${rule} !important`)
	.join("; ");

const STYLE = `
.screen {
	--ink: #0b0e11;
	--line: #293039;
	--raised: #171d23;
	--edge: #343e48;
	--text: #e6ebef;
	--text-dim: #c4cbd4;
	--muted: #a2aeb9;
	--ease: cubic-bezier(0.23, 1, 0.32, 1);
	color-scheme: dark;
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	overflow: hidden;
	overscroll-behavior: contain;
	background: var(--ink);
	color: var(--text);
	font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 14px;
	line-height: 20px;
	font-weight: 400;
	-webkit-font-smoothing: antialiased;
	cursor: default;
	user-select: none;
	animation: screen-in 200ms ease-out both;
}
@media (prefers-color-scheme: light) {
	.screen {
		--ink: #f8fafc;
		--line: #d8dfe7;
		--raised: #ffffff;
		--edge: #cbd3dd;
		--text: #202832;
		--text-dim: #344252;
		--muted: #516172;
		color-scheme: light;
	}
}
*, *::before, *::after { box-sizing: border-box; }
.block {
	display: flex;
	flex-direction: column;
	align-items: center;
	width: 100%;
	max-width: 480px;
	/* A little above the true middle reads as centred. */
	padding: 0 24px 48px;
	text-align: center;
	outline: none;
	animation: block-in 200ms var(--ease) both;
}
.mark {
	display: block;
	width: 48px;
	height: 48px;
	margin: 0 0 24px;
	/* The icon is a filled tile; round it like the app icon it is. */
	border-radius: 12px;
	/* A hairline keeps the pale tile's edge on a pale background. */
	box-shadow: 0 0 0 1px var(--line);
}
.title {
	margin: 0;
	font-size: 20px;
	line-height: 28px;
	font-weight: 500;
	color: var(--text);
	text-wrap: balance;
}
.progress {
	position: relative;
	width: 96px;
	height: 2px;
	margin-top: 16px;
	border-radius: 1px;
	background: var(--line);
	overflow: hidden;
}
.progress::after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 40%;
	border-radius: 1px;
	background: var(--text-dim);
	animation: travel 1400ms cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.count {
	margin: 12px 0 0;
	color: var(--text-dim);
	font-variant-numeric: tabular-nums;
}
.note {
	max-width: 420px;
	margin: 32px 0 0;
	font-size: 13px;
	line-height: 20px;
	color: var(--muted);
	text-wrap: pretty;
}
.close {
	height: 32px;
	margin-top: 24px;
	padding: 0 16px;
	border: 1px solid var(--edge);
	border-radius: 8px;
	background: var(--raised);
	color: var(--text);
	font: inherit;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition: background-color 150ms ease, border-color 150ms ease, transform 160ms var(--ease);
}
@media (hover: hover) and (pointer: fine) {
	.close:hover { background: var(--line); }
}
.close:active { transform: scale(0.97); }
.close:focus-visible { outline: 2px solid var(--text-dim); outline-offset: 2px; }
[hidden] { display: none !important; }
@keyframes screen-in { from { opacity: 0; } }
@keyframes block-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes travel {
	from { transform: translateX(-100%); }
	to { transform: translateX(250%); }
}
@keyframes breathe { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
	.block { animation: screen-in 200ms ease-out both; }
	.close { transition: background-color 150ms ease, border-color 150ms ease; }
	.close:active { transform: none; }
	.progress::after { width: 100%; animation: breathe 2400ms ease-in-out infinite; }
}
`;

export interface ImportOverlayDependencies {
	document: Document;
	/** The extension's own icon, as a data URL, so no page-visible resource is needed. */
	markSrc: string;
	onClose(): void;
}

export function createImportOverlay(deps: ImportOverlayDependencies) {
	const { document } = deps;
	let host: HTMLElement | null = null;
	let parts: {
		block: HTMLElement;
		title: HTMLElement;
		progress: HTMLElement;
		count: HTMLElement;
		note: HTMLElement;
		close: HTMLButtonElement;
	} | null = null;
	let showingClose = false;

	// The person's input stops at the screen. Keys typed while it has focus
	// would otherwise bubble out of the shadow root to the platform's own
	// shortcuts (X likes a post on "l"). Programmatic scrolling is untouched.
	const swallow = (event: Event) => event.stopPropagation();
	const hold = (event: Event) => {
		if (event.cancelable) event.preventDefault();
		event.stopPropagation();
	};

	const build = () => {
		const next = document.createElement(TAG);
		next.setAttribute("style", HOST_STYLE);
		const root = next.attachShadow({ mode: "closed" });
		const style = document.createElement("style");
		style.textContent = STYLE;

		const screen = document.createElement("div");
		screen.className = "screen";
		const block = document.createElement("div");
		block.className = "block";
		block.setAttribute("role", "dialog");
		block.setAttribute("aria-modal", "true");
		block.setAttribute("aria-labelledby", "anansi-import-title");
		block.tabIndex = -1;

		const mark = document.createElement("img");
		mark.className = "mark";
		mark.src = deps.markSrc;
		mark.alt = "";
		mark.width = 48;
		mark.height = 48;
		mark.draggable = false;

		const title = document.createElement("p");
		title.className = "title";
		title.id = "anansi-import-title";
		title.setAttribute("aria-live", "polite");

		const progress = document.createElement("div");
		progress.className = "progress";
		progress.setAttribute("aria-hidden", "true");

		const count = document.createElement("p");
		count.className = "count";

		const note = document.createElement("p");
		note.className = "note";

		const close = document.createElement("button");
		close.type = "button";
		close.className = "close";
		close.textContent = "Close";
		close.addEventListener("click", () => deps.onClose());

		block.append(mark, title, progress, count, note, close);
		screen.append(block);
		root.append(style, screen);

		for (const type of ["keydown", "keyup", "keypress"]) next.addEventListener(type, swallow);
		for (const type of ["wheel", "touchmove"]) next.addEventListener(type, hold, { passive: false });
		next.addEventListener("contextmenu", hold);

		host = next;
		parts = { block, title, progress, count, note, close };
		showingClose = false;
	};

	return {
		render(copy: ImportScreenCopy) {
			if (!host || !parts) build();
			const current = parts!;
			current.title.textContent = copy.title;
			current.progress.hidden = !copy.busy;
			current.count.hidden = copy.count === null;
			current.count.textContent = copy.count ?? "";
			current.note.textContent = copy.note;
			current.close.hidden = !copy.closeButton;
			// First draw, or the page replaced its own tree and took the screen with it.
			if (!host!.isConnected) {
				(document.documentElement ?? document.body).append(host!);
				current.block.focus({ preventScroll: true });
			}
			if (copy.closeButton && !showingClose) current.close.focus({ preventScroll: true });
			showingClose = copy.closeButton;
		},
		remove() {
			host?.remove();
			host = null;
			parts = null;
		},
	};
}
