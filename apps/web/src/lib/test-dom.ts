// @ts-expect-error jsdom is a test-only dependency without declarations.
import { JSDOM } from "jsdom";

/**
 * A jsdom window installed as the globals React expects, for one test.
 * Returns the window and a restore function that puts the globals back.
 */
export function installDom(): { window: any; restore: () => void } {
	const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
	const keys = [
		"window",
		"document",
		"navigator",
		"HTMLElement",
		"HTMLImageElement",
		"Element",
		"Node",
		"Event",
		"MouseEvent",
		"PointerEvent",
		"KeyboardEvent",
		"FocusEvent",
		"getComputedStyle",
		"IS_REACT_ACT_ENVIRONMENT",
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"ResizeObserver",
	];
	const previous = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
	class NoopResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	for (const k of keys) {
		const value =
			k === "IS_REACT_ACT_ENVIRONMENT"
				? true
				: k === "requestAnimationFrame"
					? (f: () => void) => setTimeout(f, 0)
					: k === "cancelAnimationFrame"
						? clearTimeout
						: k === "ResizeObserver"
							? NoopResizeObserver
							: k === "PointerEvent"
								? (dom.window.PointerEvent ?? dom.window.MouseEvent)
								: k === "getComputedStyle"
									? dom.window.getComputedStyle.bind(dom.window)
									: dom.window[k];
		Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
	}
	return {
		window: dom.window,
		restore: () => {
			keys.forEach((k, i) => {
				const desc = previous[i];
				if (desc) Object.defineProperty(globalThis, k, desc);
				else delete (globalThis as any)[k];
			});
			dom.window.close();
		},
	};
}
