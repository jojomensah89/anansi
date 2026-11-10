import { describe, expect, test } from "bun:test";
import { describeSource, type SourceSnapshot } from "./popup-state.ts";
import { IMPORT_EVERYTHING, sourceRowView } from "./popup-view.ts";

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
	test("history that never finished importing has one label: Import everything", () => {
		expect(row({}, { initialImportDue: true }).label).toBe(IMPORT_EVERYTHING);
		expect(row({ held: 12 }, { initialImportDue: true }).label).toBe(IMPORT_EVERYTHING);
		expect(row({ held: 12 }).label).toBe("Import");
		for (const view of [row({}, { initialImportDue: true }), row({ held: 3 })]) {
			expect(view.label).not.toMatch(/history/i);
			expect(view.action).toBe("import");
		}
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
		expect(row({ enabled: false })).toMatchObject({ action: "none", label: "", status: "Off in Sources" });
		expect(row({}, { offline: true })).toMatchObject({ action: "none", status: "", label: "" });
	});
});
