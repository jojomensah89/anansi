import { describe, expect, test } from "bun:test";
import type { SyncStateRecord } from "./idb-outbox.ts";
import {
	createSourceImportLifecycle,
	SourceImportLifecycleError,
} from "./source-import-lifecycle.ts";
import { createSourceRuns, type SyncStateStore } from "./source-runs.ts";

class MemorySyncState implements SyncStateStore {
	records = new Map<string, SyncStateRecord>();
	async getSyncState(source: string) {
		return structuredClone(this.records.get(source) ?? null);
	}
	async putSyncState(state: SyncStateRecord) {
		this.records.set(state.source, structuredClone(state));
	}
	async deleteSyncState(source: string) {
		this.records.delete(source);
	}
}

function setup(
	options: {
		enabled?: () => Promise<boolean>;
		queue?: (
			page: Parameters<
				NonNullable<
					Parameters<typeof createSourceImportLifecycle>[0]["enqueuePage"]
				>
			>[0],
		) => Promise<void>;
	} = {},
) {
	const store = new MemorySyncState();
	let now = 10_000;
	let sequence = 0;
	const runs = createSourceRuns({
		store,
		now: () => now,
		createId: () => `run-${++sequence}`,
	});
	const queued: unknown[] = [];
	const lifecycle = createSourceImportLifecycle({
		runs,
		enqueuePage: async (page) => {
			queued.push(page);
			await options.queue?.(page);
		},
		isEnabled: options.enabled ?? (async () => true),
		now: () => now,
	});
	return {
		lifecycle,
		runs,
		queued,
		store,
		setNow(value: number) {
			now = value;
		},
	};
}

async function begin(
	lifecycle: ReturnType<typeof createSourceImportLifecycle>,
	mode: "full" | "live" = "full",
) {
	const started = await lifecycle.start("x", mode);
	expect(started.kind).toBe("started");
	if (started.kind !== "started") throw new Error("run did not start");
	return started.run.runId;
}

function page(
	runId: string,
	overrides: Partial<
		Parameters<ReturnType<typeof createSourceImportLifecycle>["page"]>[0]
	> = {},
) {
	return {
		source: "x" as const,
		runId,
		page: 1,
		items: 1,
		cursor: "cursor-next",
		raw: { id: "item" },
		captureMethod: "platform_import" as const,
		...overrides,
	};
}

describe("source import lifecycle", () => {
	test("advances the cursor only after a durable queue acknowledgement", async () => {
		let acknowledge!: () => void;
		const gate = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const { lifecycle, runs } = setup({ queue: async () => gate });
		const runId = await begin(lifecycle);
		const pending = lifecycle.page(page(runId));
		await Promise.resolve();
		expect((await runs.current("x")).cursor).toBeUndefined();
		acknowledge();
		expect((await pending).kind).toBe("accepted-page");
		expect((await runs.current("x")).cursor).toBe("cursor-next");
	});

	test("queue-full failure preserves the last acknowledged cursor", async () => {
		const { lifecycle, runs } = setup({
			queue: async () => {
				throw new Error("queue full");
			},
		});
		const runId = await begin(lifecycle);
		await runs.setCursor("x", "already-acknowledged");
		const outcome = await lifecycle.page(page(runId));
		expect(outcome.kind).toBe("queue-failed");
		expect(outcome.durable).toBe(false);
		expect((await runs.current("x")).cursor).toBe("already-acknowledged");
	});

	test("queue failure poisons the run so later pages and done cannot advance it", async () => {
		const { lifecycle, runs } = setup({
			queue: async () => {
				const error = new Error("full") as Error & { code: string };
				error.code = "queue_full";
				throw error;
			},
		});
		const runId = await begin(lifecycle);
		const outcome = await lifecycle.page(page(runId));
		expect(outcome).toMatchObject({
			kind: "queue-failed",
			errorCode: "queue_full",
			durable: false,
		});
		expect((await runs.current("x")).phase).toBe("idle");
		expect(await lifecycle.page(page(runId, { page: 2 }))).toMatchObject({
			kind: "ignored-stale",
		});
		expect(await lifecycle.complete({ source: "x", runId })).toMatchObject({
			kind: "ignored-stale",
		});
		expect(await runs.initialImportDue("x")).toBe(true);
	});

	test("serializes done behind a page acknowledgement", async () => {
		let acknowledge!: () => void;
		const gate = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const order: string[] = [];
		const { lifecycle, runs } = setup({
			queue: async () => {
				order.push("enqueue-start");
				await gate;
				order.push("enqueue-end");
			},
		});
		const runId = await begin(lifecycle);
		const pageResult = lifecycle.page(page(runId));
		const doneResult = lifecycle.complete({ source: "x", runId });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["enqueue-start"]);
		expect((await runs.current("x")).phase).toBe("running");
		acknowledge();
		expect((await pageResult).kind).toBe("accepted-page");
		expect((await doneResult).kind).toBe("completed");
		expect(order).toEqual(["enqueue-start", "enqueue-end"]);
	});

	test("late page and completion callbacks cannot mutate a replacement run", async () => {
		const { lifecycle, runs } = setup();
		const oldRun = await begin(lifecycle);
		await lifecycle.stop("x", oldRun);
		const newRun = await begin(lifecycle);
		expect(await lifecycle.page(page(oldRun))).toMatchObject({
			kind: "ignored-stale",
		});
		expect(
			await lifecycle.complete({ source: "x", runId: oldRun }),
		).toMatchObject({ kind: "ignored-stale" });
		expect((await runs.current("x")).runId).toBe(newRun);
		expect((await runs.current("x")).phase).toBe("running");
	});

	test("live refreshes never overwrite a full-import resume cursor", async () => {
		const { lifecycle, runs } = setup();
		const fullRun = await begin(lifecycle, "full");
		await lifecycle.page(page(fullRun, { cursor: "full-next" }));
		await lifecycle.complete({ source: "x", runId: fullRun });
		const liveRun = await begin(lifecycle, "live");
		await lifecycle.page(page(liveRun, { cursor: "live-must-not-persist" }));
		await lifecycle.complete({
			source: "x",
			runId: liveRun,
			initialImport: false,
		});
		expect((await runs.current("x")).cursor).toBe("full-next");
	});

	test("pending saves flush only after the run has accepted its content page", async () => {
		const order: string[] = [];
		const store = new MemorySyncState();
		const runs = createSourceRuns({
			store,
			now: () => 10_000,
			createId: () => "ordered",
		});
		const lifecycle = createSourceImportLifecycle({
			runs,
			enqueuePage: async () => {
				order.push("page");
			},
			flushPendingSaves: async () => {
				order.push("save");
			},
		});
		const runId = await begin(lifecycle);
		await runs.recordPendingSave("x", "item-1");
		await lifecycle.page(page(runId));
		await lifecycle.complete({ source: "x", runId });
		expect(order).toEqual(["page", "save"]);
	});

	test("stop keeps the acknowledged cursor and requests only the owned tab for cleanup", async () => {
		const { lifecycle, runs } = setup();
		const runId = await begin(lifecycle);
		await lifecycle.bindTab("x", runId, 42, true);
		await runs.setCursor("x", "safe-point");
		const outcome = await lifecycle.stop("x", runId);
		expect(outcome.kind).toBe("cancelled");
		expect(outcome.effects).toContainEqual({
			kind: "close-owned-tab",
			source: "x",
			runId,
			expectedTabId: 42,
		});
		expect((await runs.current("x")).cursor).toBe("safe-point");
	});

	test("a worker restart resumes from persisted state", async () => {
		const first = setup();
		const runId = await begin(first.lifecycle);
		await first.lifecycle.page(page(runId, { cursor: "after-page-1" }));
		await first.lifecycle.stop("x", runId);
		const revivedRuns = createSourceRuns({
			store: first.store,
			now: () => 20_000,
			createId: () => "revived",
		});
		const revived = createSourceImportLifecycle({
			runs: revivedRuns,
			enqueuePage: async () => {},
			now: () => 20_000,
		});
		const restarted = await revived.start("x", "full");
		expect(restarted.kind).toBe("started");
		expect(restarted.run.cursor).toBe("after-page-1");
	});

	test("page-limit exhaustion stops without fabricating initial completion", async () => {
		const { lifecycle, runs } = setup();
		const runId = await begin(lifecycle);
		const outcome = await lifecycle.complete({
			source: "x",
			runId,
			state: "limited",
		});
		expect(outcome.kind).toBe("limited");
		expect(await runs.initialImportDue("x")).toBe(true);
		expect((await runs.current("x")).phase).toBe("idle");
	});

	test("disabled sources stop a running session and preserve history", async () => {
		let enabled = true;
		const { lifecycle, runs } = setup({ enabled: async () => enabled });
		const runId = await begin(lifecycle);
		await runs.setCursor("x", "last-good");
		enabled = false;
		const outcome = await lifecycle.page(page(runId));
		expect(outcome.kind).toBe("disabled");
		expect((await runs.current("x")).phase).toBe("idle");
		expect((await runs.current("x")).cursor).toBe("last-good");
	});

	test("disabled start reports the stopped state, not a false active run", async () => {
		let enabled = true;
		const { lifecycle, runs } = setup({ enabled: async () => enabled });
		await begin(lifecycle);
		enabled = false;
		const outcome = await lifecycle.start("x");
		expect(outcome.kind).toBe("disabled");
		if (outcome.kind === "disabled") {
			expect(outcome.run.phase).toBe("idle");
			expect(outcome.run.startedAt).toBeUndefined();
		}
		expect((await runs.current("x")).phase).toBe("idle");
	});

	test("rate limiting keeps the run recoverable and schedules a fenced retry", async () => {
		const { lifecycle, runs } = setup();
		const runId = await begin(lifecycle);
		const outcome = await lifecycle.fail({
			source: "x",
			runId,
			code: "rate_limited",
			retryAfterMs: 5_000,
		});
		expect(outcome.kind).toBe("rate-limited");
		expect(
			outcome.effects.some((effect) => effect.kind === "schedule-recovery"),
		).toBe(true);
		expect((await runs.current("x")).phase).toBe("running");
	});

	test("lifecycle errors expose a stable error for session adapters", () => {
		const error = new SourceImportLifecycleError("queue_full", "full");
		expect(error.name).toBe("SourceImportLifecycleError");
		expect(error.code).toBe("queue_full");
	});
});
