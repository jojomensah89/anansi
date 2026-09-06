import { describe, expect, test } from "bun:test";
import {
	describeQueue,
	describeSource,
	isSettled,
	RUN_TIMEOUT_MS,
	redactError,
	type SourceSnapshot,
	withoutStartingSource,
} from "./popup-state.ts";

const NOW = 1_756_700_000_000;
const EMPTY = { queued: 0, uploading: 0, retrying: 0, failed: 0 };

test("a completed start command clears only its optimistic source marker", () => {
	const starting = new Set(["x", "tiktok"]);

	expect(withoutStartingSource(starting, "tiktok")).toEqual(new Set(["x"]));
	expect(starting).toEqual(new Set(["x", "tiktok"]));
});

const snapshot = (patch: Partial<SourceSnapshot> = {}): SourceSnapshot => ({
	source: "x",
	enabled: true,
	phase: "idle",
	queue: { ...EMPTY },
	...patch,
});

describe("describeSource", () => {
	test("maps GitHub's durable states to its shared controls", () => {
		expect(
			describeSource(
				snapshot({
					source: "github",
					phase: "running",
					startedAt: NOW - 1_000,
				}),
				NOW,
			),
		).toMatchObject({
			state: "running",
			action: "pause",
			actionLabel: "Pause",
		});
		expect(
			describeSource(
				snapshot({ source: "github", paused: true, held: 25 }),
				NOW,
			),
		).toMatchObject({
			state: "paused",
			action: "import",
			actionLabel: "Resume",
		});
		expect(
			describeSource(
				snapshot({ source: "github", lastErrorCode: "not_signed_in" }),
				NOW,
			),
		).toMatchObject({
			state: "sign_in_required",
			action: "import",
			actionLabel: "Try again",
		});
		expect(
			describeSource(
				snapshot({ source: "github", held: 25, lastRun: NOW - 60_000 }),
				NOW,
			),
		).toMatchObject({ state: "synced", action: "import" });
	});

	test("a source the server switched off says so and offers nothing", () => {
		const view = describeSource(snapshot({ enabled: false, held: 500 }), NOW);

		expect(view.state).toBe("disabled");
		expect(view.action).toBe("none");
	});

	test("a live run is running, and offers Pause rather than Stop", () => {
		const view = describeSource(
			snapshot({ phase: "running", startedAt: NOW - 5_000 }),
			NOW,
		);

		expect(view.state).toBe("running");
		expect(view.action).toBe("pause");
		expect(view.actionLabel).toBe("Pause");
	});

	test("a run that went quiet is stalled, not still importing", () => {
		const view = describeSource(
			snapshot({ phase: "running", startedAt: NOW - RUN_TIMEOUT_MS - 1 }),
			NOW,
		);

		expect(view.state).toBe("stalled");
		expect(view.action).toBe("import");
	});

	test("a long import stays running while durable progress is recent", () => {
		expect(
			describeSource(
				snapshot({
					phase: "running",
					startedAt: NOW - 180_000,
					updatedAt: NOW - 1_000,
				}),
				NOW,
			),
		).toMatchObject({ state: "running", action: "pause" });
	});

	test("a run recorded before a restart cannot still claim to be running", () => {
		// The exact shape of the bug this replaces: a worker died mid-run and
		// the stored phase outlived it by days.
		const view = describeSource(
			snapshot({ phase: "running", startedAt: NOW - 3 * 24 * 60 * 60 * 1000 }),
			NOW,
		);

		expect(view.state).toBe("stalled");
	});

	test("a stale signed-out result can recheck the current session", () => {
		const view = describeSource(
			snapshot({ lastErrorCode: "not_signed_in", held: 1_200 }),
			NOW,
		);

		expect(view.state).toBe("sign_in_required");
		expect(view.action).toBe("import");
		expect(view.actionLabel).toBe("Try again");
	});

	test("delivery failures stay visible without replacing Import", () => {
		const view = describeSource(
			snapshot({ queue: { ...EMPTY, failed: 3 }, held: 900 }),
			NOW,
		);

		expect(view.state).toBe("failed");
		expect(view.text).toBe("3 captures could not be sent");
		expect(view.action).toBe("import");
		expect(view.actionLabel).toBe("Import");
	});

	test("retrying and queued are told apart", () => {
		expect(
			describeSource(snapshot({ queue: { ...EMPTY, retrying: 2 } }), NOW).state,
		).toBe("retrying");
		expect(
			describeSource(snapshot({ queue: { ...EMPTY, queued: 2 } }), NOW).state,
		).toBe("queued");
		expect(
			describeSource(snapshot({ queue: { ...EMPTY, uploading: 1 } }), NOW)
				.state,
		).toBe("queued");
		for (const queue of [
			{ ...EMPTY, retrying: 2 },
			{ ...EMPTY, queued: 2 },
			{ ...EMPTY, uploading: 1 },
		]) {
			expect(describeSource(snapshot({ queue }), NOW).action).toBe("import");
		}
	});

	test("pausing says nothing was lost, because nothing was", () => {
		const view = describeSource(snapshot({ paused: true, held: 40 }), NOW);

		expect(view.state).toBe("paused");
		expect(view.actionLabel).toBe("Resume");
	});

	test("a settled source with items is synced, and says when", () => {
		const view = describeSource(
			snapshot({ held: 1_274, lastRun: NOW - 5 * 60_000 }),
			NOW,
		);

		expect(view.state).toBe("synced");
		expect(view.text).toBe("1,274 saved · 5 minutes ago");
		expect(view.settled).toBe(true);
	});

	test("an empty source is ready rather than synced", () => {
		expect(describeSource(snapshot({ held: 0 }), NOW).state).toBe("ready");
	});

	test("a failed history request stays visible even when old saves exist", () => {
		for (const code of [
			"rate_limited",
			"page_shape_changed",
			"platform_request_failed",
		]) {
			expect(
				describeSource(
					snapshot({ source: "reddit", held: 900, lastErrorCode: code }),
					NOW,
				),
			).toMatchObject({ state: "failed", action: "import" });
		}
	});
});

describe("synced is impossible while work is outstanding", () => {
	const outstanding = [
		{ queued: 1, uploading: 0, retrying: 0, failed: 0 },
		{ queued: 0, uploading: 1, retrying: 0, failed: 0 },
		{ queued: 0, uploading: 0, retrying: 1, failed: 0 },
		{ queued: 0, uploading: 0, retrying: 0, failed: 1 },
	];

	test.each(outstanding)("not synced with %o", (queue) => {
		const view = describeSource(
			snapshot({ queue, held: 1_274, lastRun: NOW - 1_000 }),
			NOW,
		);

		expect(view.state).not.toBe("synced");
		expect(view.settled).toBe(false);
		expect(view.text).not.toContain("saved");
	});

	test("outstanding work outranks a pause, so it stays visible", () => {
		const view = describeSource(
			snapshot({ paused: true, queue: { ...EMPTY, failed: 2 } }),
			NOW,
		);

		expect(view.state).toBe("failed");
	});

	test("isSettled agrees with the states that claim to be settled", () => {
		expect(isSettled(snapshot({ held: 10 }))).toBe(true);
		expect(isSettled(snapshot({ phase: "running", startedAt: NOW }))).toBe(
			false,
		);
		expect(isSettled(snapshot({ queue: { ...EMPTY, failed: 1 } }))).toBe(false);
	});
});

describe("describeQueue", () => {
	test("leads with failures when there are any", () => {
		const view = describeQueue({
			queued: 2,
			uploading: 0,
			retrying: 1,
			failed: 4,
		});

		expect(view.text).toBe("4 failed · 3 waiting");
		expect(view.canRetry).toBe(true);
		expect(view.total).toBe(7);
	});

	test("counts waiting work when nothing has failed", () => {
		const view = describeQueue({
			queued: 3,
			uploading: 1,
			retrying: 0,
			failed: 0,
		});

		expect(view.text).toBe("4 waiting to send");
		expect(view.tone).toBe("muted");
	});

	test("an empty outbox has nothing to retry", () => {
		const view = describeQueue({
			queued: 0,
			uploading: 0,
			retrying: 0,
			failed: 0,
		});

		expect(view.total).toBe(0);
		expect(view.canRetry).toBe(false);
	});
});

describe("redactError", () => {
	test("removes a bearer token", () => {
		const out = redactError(
			"401 from http://127.0.0.1:8788/api/ingest with Bearer sk_live_abcdef123456",
		);

		expect(out).not.toContain("sk_live_abcdef123456");
		expect(out).toContain("Bearer ***");
	});

	test("removes named credentials whatever the separator", () => {
		for (const raw of [
			"token=abcdef0123456789",
			"authorization: Basic bXktc2VjcmV0",
			"ct0=9f8e7d6c5b4a",
			"password: hunter2correct",
		]) {
			const out = redactError(raw);
			expect(out).toMatch(/\*\*\*/);
		}
	});

	test("keeps a URL path but drops its query", () => {
		const out = redactError(
			"failed GET /api/info.json?id=t3_secret&raw_json=1",
		);

		expect(out).toContain("/api/info.json");
		expect(out).not.toContain("t3_secret");
	});

	test("removes anything long enough to be a secret", () => {
		const secret = "A".repeat(48);
		expect(redactError(`unexpected ${secret}`)).not.toContain(secret);
	});

	test("keeps an ordinary message readable and bounded", () => {
		expect(redactError("server unreachable")).toBe("server unreachable");
		expect(redactError("x".repeat(400)).length).toBeLessThanOrEqual(180);
	});
});
