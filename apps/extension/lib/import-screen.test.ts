import { describe, expect, test } from "bun:test";
import {
	IMPORT_SCREEN_DONE_MS,
	type ImportScreenCommand,
	createImportScreens,
	importScreenCopy,
	importScreenEligible,
	importScreenEnding,
	isImportScreenCloseRequest,
	parseImportScreenCommand,
} from "./import-screen.ts";

describe("which tabs get the import screen", () => {
	test("only a tab Anansi opened for a history import of a tab-driven source", () => {
		expect(importScreenEligible({ source: "x", owned: true, runMode: "full" })).toBe(true);
		expect(importScreenEligible({ source: "tiktok", owned: true, runMode: "full" })).toBe(true);
	});

	test("never a tab the person already had open", () => {
		expect(importScreenEligible({ source: "x", owned: false, runMode: "full" })).toBe(false);
	});

	test("never a live sync or a run without a mode", () => {
		expect(importScreenEligible({ source: "x", owned: true, runMode: "live" })).toBe(false);
		expect(importScreenEligible({ source: "tiktok", owned: true, runMode: "live" })).toBe(false);
		expect(importScreenEligible({ source: "x", owned: true, runMode: undefined })).toBe(false);
	});

	test("never sources that import without a tab", () => {
		for (const source of ["reddit", "github", "web"]) {
			expect(importScreenEligible({ source, owned: true, runMode: "full" })).toBe(false);
		}
	});
});

describe("what the screen says", () => {
	test("running with a count", () => {
		expect(importScreenCopy({ source: "x", phase: "running", items: 1240 })).toEqual({
			title: "Importing your X bookmarks…",
			count: "1,240 saved so far",
			note: "Keep this tab open. It closes by itself when the import finishes.",
			busy: true,
			closeButton: false,
		});
	});

	test("running before any count shows only the line and the indicator", () => {
		const copy = importScreenCopy({ source: "tiktok", phase: "running", items: 0 });
		expect(copy.title).toBe("Importing your TikTok favorites…");
		expect(copy.count).toBeNull();
		expect(copy.busy).toBe(true);
		expect(copy.note).toBe("Keep this window open. It closes by itself when the import finishes.");
	});

	test("nonsense counts read as no count", () => {
		expect(importScreenCopy({ source: "x", phase: "running", items: Number.NaN }).count).toBeNull();
		expect(importScreenCopy({ source: "x", phase: "running", items: -4 }).count).toBeNull();
		expect(importScreenCopy({ source: "x", phase: "running", items: 1 }).count).toBe("1 saved so far");
	});

	test("done", () => {
		const copy = importScreenCopy({ source: "x", phase: "done", items: 1284 });
		expect(copy.title).toBe("Imported 1,284 saves");
		expect(copy.busy).toBe(false);
		expect(copy.closeButton).toBe(false);
		expect(copy.note).toBe("This tab closes in a moment");
		expect(importScreenCopy({ source: "x", phase: "done", items: 1 }).title).toBe("Imported 1 save");
		expect(importScreenCopy({ source: "tiktok", phase: "done", items: 0 }).title).toBe("No favorites to import");
	});

	test("failed says what happened in one line and offers Close", () => {
		const copy = importScreenCopy({ source: "tiktok", phase: "failed", items: 0, errorCode: "capture_timeout" });
		expect(copy.title).toBe("The TikTok page stopped responding");
		expect(copy.count).toBeNull();
		expect(copy.closeButton).toBe(true);
		expect(copy.busy).toBe(false);
		expect(importScreenCopy({ source: "x", phase: "failed", items: 40, errorCode: "not_signed_in" })).toMatchObject({
			title: "Sign in to X in this browser first",
			count: "40 saved before it stopped",
		});
		expect(importScreenCopy({ source: "x", phase: "failed", items: 0, errorCode: "something_new" }).title).toBe(
			"The import stopped before the end",
		);
	});
});

describe("messages", () => {
	test("the relay accepts only a well-formed render command", () => {
		const command = { anansi: "import-screen", action: "render", view: { source: "x", phase: "running", items: 3 } };
		expect(parseImportScreenCommand(command)).toEqual({ source: "x", phase: "running", items: 3 });
		expect(parseImportScreenCommand({ ...command, view: { ...command.view, source: "reddit" } })).toBeNull();
		expect(parseImportScreenCommand({ ...command, view: { ...command.view, phase: "other" } })).toBeNull();
		expect(parseImportScreenCommand({ ...command, view: { ...command.view, items: -1 } })).toBeNull();
		expect(parseImportScreenCommand({ ...command, anansi: "page-command" })).toBeNull();
		expect(parseImportScreenCommand(null)).toBeNull();
	});

	test("close requests", () => {
		expect(isImportScreenCloseRequest({ anansi: "import-screen", action: "close" })).toBe(true);
		expect(isImportScreenCloseRequest({ anansi: "import-screen", action: "render" })).toBe(false);
	});

	test("how a finished run ended", () => {
		expect(importScreenEnding({})).toEqual({ kind: "completed" });
		expect(importScreenEnding({ paused: true, lastErrorCode: "x" })).toEqual({ kind: "stopped" });
		expect(importScreenEnding({ lastErrorCode: "capture_timeout" })).toEqual({ kind: "failed", errorCode: "capture_timeout" });
	});
});

function harness(deliver = true) {
	const sent: { tabId: number; command: ImportScreenCommand }[] = [];
	const waits: number[] = [];
	const screens = createImportScreens({
		send: async (tabId, command) => {
			if (!deliver) throw new Error("no relay");
			sent.push({ tabId, command });
			return true;
		},
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	return { screens, sent, waits };
}

describe("the worker's import screens", () => {
	test("does nothing for a tab that is not eligible", async () => {
		const { screens, sent } = harness();
		await screens.open({ tabId: 1, source: "x", runId: "r", owned: false, runMode: "full" });
		await screens.progress(1, "r", 20);
		expect(sent).toEqual([]);
		expect(await screens.settle(1, "r", { kind: "completed" })).toBe("close");
	});

	test("sums accepted pages of its own run into a live count", async () => {
		const { screens, sent } = harness();
		await screens.open({ tabId: 7, source: "x", runId: "r", owned: true, runMode: "full" });
		await screens.progress(7, "r", 20);
		await screens.progress(7, "r", 18);
		await screens.progress(7, "other-run", 99);
		await screens.progress(8, "r", 99);
		expect(sent.map((entry) => entry.command.view.items)).toEqual([0, 20, 38]);
		expect(sent.every((entry) => entry.tabId === 7)).toBe(true);
	});

	test("a finished import shows its count, waits, then closes", async () => {
		const { screens, sent, waits } = harness();
		await screens.open({ tabId: 7, source: "x", runId: "r", owned: true, runMode: "full" });
		await screens.progress(7, "r", 5);
		expect(await screens.settle(7, "r", { kind: "completed" })).toBe("close");
		expect(sent.at(-1)?.command.view).toEqual({ source: "x", phase: "done", items: 5 });
		expect(waits).toEqual([IMPORT_SCREEN_DONE_MS]);
	});

	test("a failed import stays open until Close", async () => {
		const { screens, sent } = harness();
		await screens.open({ tabId: 7, source: "tiktok", runId: "r", owned: true, runMode: "full" });
		expect(await screens.settle(7, "r", { kind: "failed", errorCode: "capture_timeout" })).toBe("hold");
		expect(sent.at(-1)?.command.view).toEqual({ source: "tiktok", phase: "failed", items: 0, errorCode: "capture_timeout" });
		expect(screens.closeRequested(9)).toBeNull();
		expect(screens.closeRequested(7)).toEqual({ source: "tiktok", runId: "r" });
		expect(screens.closeRequested(7)).toBeNull();
		expect(await screens.settle(7, "r", { kind: "failed" })).toBe("close");
	});

	test("Close does nothing while the import is still running", async () => {
		const { screens } = harness();
		await screens.open({ tabId: 7, source: "x", runId: "r", owned: true, runMode: "full" });
		expect(screens.closeRequested(7)).toBeNull();
	});

	test("a stopped import closes at once", async () => {
		const { screens, waits } = harness();
		await screens.open({ tabId: 7, source: "x", runId: "r", owned: true, runMode: "full" });
		expect(await screens.settle(7, "r", { kind: "stopped" })).toBe("close");
		expect(waits).toEqual([]);
	});

	test("a tab whose relay never drew the screen closes the way it always did", async () => {
		const { screens, waits } = harness(false);
		await screens.open({ tabId: 7, source: "x", runId: "r", owned: true, runMode: "full" });
		expect(await screens.settle(7, "r", { kind: "failed", errorCode: "capture_timeout" })).toBe("close");
		expect(waits).toEqual([]);
	});

	test("a reloaded relay is drawn again with the current state", async () => {
		const { screens, sent } = harness();
		await screens.open({ tabId: 7, source: "tiktok", runId: "r", owned: true, runMode: "full" });
		await screens.progress(7, "r", 30);
		await screens.reattach(7);
		await screens.reattach(8);
		expect(sent.at(-1)).toEqual({
			tabId: 7,
			command: { anansi: "import-screen", action: "render", view: { source: "tiktok", phase: "running", items: 30 } },
		});
		expect(sent.length).toBe(3);
	});
});
