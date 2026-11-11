import { describe, expect, test } from "bun:test";
import { describeSource, type SourceSnapshot } from "./popup-state.ts";
import { IMPORT_ALL, permissionPromptLine, sourceRowView } from "./popup-view.ts";

const NOW = 1_756_700_000_000;
const EMPTY = { queued: 0, uploading: 0, retrying: 0, failed: 0 };

function row(snapshot: Partial<SourceSnapshot>, extra: Partial<Parameters<typeof sourceRowView>[0]> = {}) {
	const input: SourceSnapshot = { source: "tiktok", enabled: true, phase: "idle", queue: EMPTY, ...snapshot };
	return sourceRowView({
		view: describeSource(input, NOW),
		name: "TikTok",
		initialImportDue: false,
		lastErrorCode: input.lastErrorCode,
		queueFailed: input.queue.failed,
		...extra,
	});
}

describe("sourceRowView", () => {
	test("a source whose first import is due shows its status and no button", () => {
		for (const snapshot of [{}, { held: 12 }, { queue: { ...EMPTY, queued: 2 } }]) {
			const view = row(snapshot, { initialImportDue: true });
			expect(view).toMatchObject({ action: "none", label: "", busyLabel: "" });
		}
		expect(row({}, { initialImportDue: true }).status).toBe("Not imported yet");
		expect(row({ queue: { ...EMPTY, queued: 2 } }, { initialImportDue: true }).status).toBe("2 captures waiting to send");
	});

	test("a source whose history is already in needs no import button", () => {
		expect(row({})).toMatchObject({ action: "none", label: "", status: "Ready to import" });
		expect(row({ held: 12 })).toMatchObject({ action: "none", label: "", status: "12 saved" });
		expect(IMPORT_ALL).toBe("Import all");
	});

	test("a single source that was interrupted still gets its own button while the batch is due", () => {
		expect(row({ lastErrorCode: "rate_limited" }, { initialImportDue: true })).toMatchObject({
			action: "import",
			label: "Try again",
		});
		expect(row({ paused: true }, { initialImportDue: true })).toMatchObject({ action: "import", label: "Resume" });
		expect(row({ phase: "running", startedAt: NOW - 1000 }, { initialImportDue: true })).toMatchObject({
			action: "pause",
			label: "Pause",
		});
	});

	test("a run in flight offers Pause and shows its progress", () => {
		const view = row(
			{ phase: "running", startedAt: NOW - 1000, updatedAt: NOW - 500 },
			{ progress: { pages: 1240, items: 36 } },
		);
		expect(view).toMatchObject({ action: "pause", label: "Pause", tone: "active", status: "1,240 scanned, 36 new" });
		expect(row({ phase: "running", startedAt: NOW - 1000 }).status).toBe("Importing");
	});

	test("failures say what happened and offer Try again, without repeating the button", () => {
		const signIn = row({ lastErrorCode: "not_signed_in" });
		expect(signIn).toMatchObject({ status: "Sign in to TikTok first", label: "Try again", tone: "warn" });
		const stalled = row({ phase: "running", startedAt: NOW - 10 * 60_000 });
		expect(stalled).toMatchObject({ status: "Stopped responding", label: "Try again" });
		expect(row({ lastErrorCode: "capture_timeout" }).status).toBe("Stalled. Keep its window visible");
		expect(row({ lastErrorCode: "rate_limited" }).status).toBe("Rate limited by TikTok");
		expect(row({ lastErrorCode: "something_new" }).status).toBe("Import failed");
		for (const view of [signIn, stalled, row({ lastErrorCode: "capture_failed" })])
			expect(view.status).not.toMatch(/press|import to/i);
	});

	test("captures the outbox gave up on are counted, not hidden behind an old error", () => {
		const view = row({ lastErrorCode: "capture_failed", queue: { ...EMPTY, failed: 3 } });
		expect(view).toMatchObject({ status: "3 captures could not be sent", label: "Try again" });
	});

	test("paused, switched off and offline rows", () => {
		expect(row({ paused: true })).toMatchObject({ label: "Resume", status: "Paused. Nothing was lost" });
		expect(row({ enabled: false })).toMatchObject({ action: "none", label: "", status: "" });
		expect(row({}, { offline: true })).toMatchObject({ action: "none", status: "", label: "" });
	});
});

describe("permissionPromptLine", () => {
	test("names the library's host before Chrome asks for access", () => {
		expect(permissionPromptLine("https://anansi.example.dev", false)).toBe(
			"Chrome will ask to let Anansi reach your library at anansi.example.dev",
		);
		expect(permissionPromptLine("http://localhost:8787", false)).toBe(
			"Chrome will ask to let Anansi reach your library at localhost:8787",
		);
	});

	test("says nothing when there is no valid address or Chrome already grants it", () => {
		expect(permissionPromptLine(null, false)).toBeNull();
		expect(permissionPromptLine("https://anansi.example.dev", true)).toBeNull();
	});
});

describe("capture switch", () => {
	const toggleable = { toggleable: true } as const;

	test("an on source keeps its enabled switch without a redundant import", () => {
		const view = row({ held: 3 }, { ...toggleable, enabled: true });
		expect(view).toMatchObject({ action: "none", label: "" });
		expect(view.switch).toEqual({ checked: true, disabled: false, label: "Capture TikTok" });
		// Running rows keep Pause beside the switch.
		expect(row({ phase: "running", startedAt: NOW - 1000 }, { ...toggleable, enabled: true })).toMatchObject({
			action: "pause",
			switch: { checked: true, disabled: false },
		});
	});

	test("an off source hides its action and says nothing the switch doesn't", () => {
		const view = row({ enabled: false, held: 3 }, { ...toggleable, enabled: false });
		expect(view).toMatchObject({ action: "none", label: "", status: "", tone: "muted" });
		expect(view.switch).toEqual({ checked: false, disabled: false, label: "Capture TikTok" });
		// Without an explicit switch state the server's answer decides.
		expect(row({ enabled: false }, toggleable).switch?.checked).toBe(false);
		expect(row({}, toggleable).switch?.checked).toBe(true);
	});

	test("an optimistic flip shows at once, and the switch waits for the answer", () => {
		// Switching off: the server still lists it, but the row is already off.
		const off = row({ held: 3 }, { ...toggleable, enabled: false, switching: true });
		expect(off).toMatchObject({ action: "none", status: "" });
		expect(off.switch).toMatchObject({ checked: false, disabled: true });
		// Switching on: no Import until the server's config includes the source.
		const on = row({ enabled: false }, { ...toggleable, enabled: true, switching: true });
		expect(on).toMatchObject({ action: "none", label: "" });
		expect(on.switch).toMatchObject({ checked: true, disabled: true });
	});

	test("a failed request is rolled back with a short row-level error", () => {
		const keptOn = row({ held: 3 }, { ...toggleable, enabled: true, switchFailed: true });
		expect(keptOn).toMatchObject({ status: "Couldn't turn off", tone: "warn", action: "none" });
		expect(keptOn.switch).toMatchObject({ checked: true, disabled: false });
		const keptOff = row({ enabled: false }, { ...toggleable, enabled: false, switchFailed: true });
		expect(keptOff).toMatchObject({ status: "Couldn't turn on", tone: "warn", action: "none" });
		expect(keptOff.switch?.checked).toBe(false);
	});

	test("offline, the switch shows the last known state but cannot be pressed", () => {
		for (const enabled of [true, false]) {
			const view = row({}, { ...toggleable, enabled, offline: true });
			expect(view).toMatchObject({ action: "none", status: "" });
			expect(view.switch).toEqual({ checked: enabled, disabled: true, label: "Capture TikTok" });
		}
		// A stale failure from before the outage isn't repeated while offline.
		expect(row({}, { ...toggleable, enabled: true, offline: true, switchFailed: true }).status).toBe("");
	});

	test("a source that is always on has no switch", () => {
		expect(row({}).switch).toBeNull();
		expect(row({}, { toggleable: false }).switch).toBeNull();
	});
});
