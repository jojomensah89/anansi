/**
 * Where an import window goes.
 *
 * A hidden tab does not render, so TikTok's list never asks for its next page,
 * and a window fully covered by another counts as hidden too. So this is a small
 * window in front, in the corner of the window the person was using.
 */
export const IMPORT_WINDOW_FOCUSED = true;
export const IMPORT_WINDOW_WIDTH = 720;
export const IMPORT_WINDOW_HEIGHT = 640;
const MARGIN = 16;

export interface WindowFrame {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	state?: string;
}

export function importWindowBounds(anchor: WindowFrame | null | undefined) {
	const size = { width: IMPORT_WINDOW_WIDTH, height: IMPORT_WINDOW_HEIGHT };
	if (
		!anchor ||
		anchor.state === "minimized" ||
		anchor.left === undefined ||
		anchor.top === undefined ||
		anchor.width === undefined ||
		anchor.height === undefined
	) {
		return size;
	}
	return {
		...size,
		left: Math.max(anchor.left, anchor.left + anchor.width - IMPORT_WINDOW_WIDTH - MARGIN),
		top: Math.max(anchor.top, anchor.top + anchor.height - IMPORT_WINDOW_HEIGHT - MARGIN),
	};
}

/** Owned page imports need rendering only when walking history. */
export function importTabPresentation(ownsImportTab: boolean, live: boolean): "background" | "window" {
	return ownsImportTab && !live ? "window" : "background";
}

export interface ImportScanResult {
	stopReason?: "known" | "page_limit";
	hasMore?: boolean;
}

/** A bounded catch-up is incomplete only if history remains beyond its cap. */
export function needsFullWindowImport(live: boolean, result: ImportScanResult): boolean {
	return live && result.stopReason === "page_limit" && result.hasMore === true;
}
