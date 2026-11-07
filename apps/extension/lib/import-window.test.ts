import { describe, expect, test } from "bun:test";
import { IMPORT_WINDOW_HEIGHT, IMPORT_WINDOW_WIDTH, importWindowBounds } from "./import-window.ts";

const size = { width: IMPORT_WINDOW_WIDTH, height: IMPORT_WINDOW_HEIGHT };

describe("importWindowBounds", () => {
	test("sits in the bottom right of the window in use", () => {
		expect(importWindowBounds({ left: 100, top: 50, width: 1600, height: 1000 })).toEqual({
			...size,
			left: 100 + 1600 - IMPORT_WINDOW_WIDTH - 16,
			top: 50 + 1000 - IMPORT_WINDOW_HEIGHT - 16,
		});
	});

	test("stays inside a window smaller than itself", () => {
		expect(importWindowBounds({ left: 100, top: 50, width: 300, height: 200 })).toEqual({ ...size, left: 100, top: 50 });
	});

	test("lets the browser place it when there is nothing to anchor to", () => {
		expect(importWindowBounds(null)).toEqual(size);
		expect(importWindowBounds({ left: 0, top: 0, width: 800, height: 600, state: "minimized" })).toEqual(size);
		expect(importWindowBounds({ width: 800, height: 600 })).toEqual(size);
	});
});
