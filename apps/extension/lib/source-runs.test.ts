import { describe, expect, test } from "bun:test";
import type { SyncStateRecord } from "./idb-outbox.ts";
import {
	captureDeliveryMode,
	createSourceRuns,
	isExpectedImportTab,
	SOURCE_RUN_LEASE_MS,
	type SyncStateStore,
} from "./source-runs.ts";

class MemorySyncState implements SyncStateStore {
	readonly records = new Map<string, SyncStateRecord>();

	async getSyncState(source: string): Promise<SyncStateRecord | null> {
		return structuredClone(this.records.get(source) ?? null);
	}

	async putSyncState(state: SyncStateRecord): Promise<void> {
		this.records.set(state.source, structuredClone(state));
	}

	async deleteSyncState(source: string): Promise<void> {
		this.records.delete(source);
	}
}

const setup = () => {
	const store = new MemorySyncState();
	let now = 10_000;
	let sequence = 0;
	const runs = createSourceRuns({
		store,
		now: () => now,
		createId: () => `run-${++sequence}`,
	});
	return {
		store,
		runs,
		setNow(value: number) {
			now = value;
		},
	};
};

describe("source runs", () => {
	test("prevents overlapping runs for one source", async () => {
		const { runs } = setup();
		const first = await runs.begin("x");
		const overlap = await runs.begin("x");
		const otherSource = await runs.begin("reddit");

		expect(first.started).toBe(true);
		expect(overlap).toEqual({ started: false, run: first.run });
		expect(otherSource.started).toBe(true);
		expect(otherSource.run.runId).not.toBe(first.run.runId);
	});

	test("recovers an expired run without losing its resume cursor", async () => {
		const { runs, setNow } = setup();
		const first = await runs.begin("github");
		await runs.setCursor("github", "https://github.com/stars?after=cursor-9");
		setNow(first.run.startedAt + SOURCE_RUN_LEASE_MS);

		const recovered = await runs.begin("github", "full");

		expect(recovered.started).toBe(true);
		expect(recovered.run.runId).not.toBe(first.run.runId);
		expect(recovered.run.cursor).toBe(
			"https://github.com/stars?after=cursor-9",
		);
	});

	test("replacement runs do not inherit the previous owned tab", async () => {
		const { runs, setNow } = setup();
		const first = await runs.begin("x");
		await runs.setOwnedTab("x", 42);
		setNow(first.run.startedAt + SOURCE_RUN_LEASE_MS);

		const replacement = await runs.begin("x");

		expect(replacement.replacedOwnedTabId).toBe(42);
		expect(replacement.replacedRunId).toBe(first.run.runId);
		expect(replacement.run.createdTabId).toBeUndefined();
		expect(await runs.takeOwnedTabForRun("x", first.run.runId, 42)).toBe(42);
	});

	test("a stopped run cannot release a replacement-owned tab", async () => {
		const { runs } = setup();
		const first = await runs.begin("x");
		await runs.setOwnedTab("x", 42);
		const stopped = await runs.stopForRun("x", first.run.runId);
		expect(stopped).toEqual({ stopped: true, tabId: 42 });

		const replacement = await runs.begin("x");
		await runs.setOwnedTabForRun("x", replacement.run.runId, 99);
		expect(await runs.isOwnedTabForRun("x", first.run.runId, 42)).toBe(true);
		expect(await runs.takeOwnedTabForRun("x", first.run.runId, 42)).toBe(42);
		expect(await runs.takeOwnedTabForRun("x", replacement.run.runId, 99)).toBe(
			99,
		);
	});

	test("a replacement using the old tab prevents orphan cleanup", async () => {
		const { runs } = setup();
		const first = await runs.begin("x");
		await runs.setOwnedTab("x", 42);
		await runs.stopForRun("x", first.run.runId);
		const replacement = await runs.begin("x");
		await runs.setActiveTab("x", replacement.run.runId, 42);

		expect(await runs.isOwnedTabForRun("x", first.run.runId, 42)).toBe(false);
		expect(await runs.takeOwnedTabForRun("x", first.run.runId, 42)).toBeNull();
	});

	test("assigns stable page identities inside a persisted run", async () => {
		const { runs } = setup();
		const { run } = await runs.begin("reddit");
		const pageOne = await runs.capturePage("reddit", 1);
		const replayedPage = await runs.capturePage("reddit", 1);
		const observedPage = await runs.capturePage("reddit");

		expect(pageOne).toEqual({
			runId: run.runId,
			page: 1,
			eventId: `${run.runId}:page:1`,
		});
		expect(replayedPage).toEqual(pageOne);
		expect(observedPage.page).toBe(2);
	});

	test("coalesces repeated live refresh signals durably", async () => {
		const { runs, store } = setup();
		await Promise.all([
			runs.requestRefresh("x"),
			runs.requestRefresh("x"),
			runs.requestRefresh("x"),
		]);

		expect((await store.getSyncState("x"))?.pendingRefresh).toBe(true);
		expect(await runs.claimRefresh("x")).toBe(true);
		expect(await runs.claimRefresh("x")).toBe(false);
	});

	test("does not claim a pending refresh while its source is running", async () => {
		const { runs } = setup();
		await runs.begin("x");
		await runs.requestRefresh("x");
		expect(await runs.claimRefresh("x")).toBe(false);

		await runs.finish("x");
		expect(await runs.claimRefresh("x")).toBe(true);
	});

	test("releases only a tab recorded as created by Anansi", async () => {
		const { runs } = setup();
		await runs.begin("reddit");
		await runs.setOwnedTab("reddit", 42);

		expect(await runs.takeOwnedTab("reddit", 99)).toBeNull();
		expect(await runs.takeOwnedTab("reddit", 42)).toBe(42);
		expect(await runs.takeOwnedTab("reddit", 42)).toBeNull();
	});

	test("stop persists an idle run and returns its owned tab", async () => {
		const { runs, store, setNow } = setup();
		await runs.begin("x");
		await runs.setOwnedTab("x", 7);
		setNow(20_000);

		expect(await runs.stop("x")).toBe(7);
		expect(await store.getSyncState("x")).toMatchObject({
			phase: "idle",
			createdTabId: undefined,
			updatedAt: 20_000,
		});
	});
});

describe("import-route selection", () => {
	test("selects only the expected X bookmarks route", () => {
		expect(isExpectedImportTab("x", "https://x.com/i/bookmarks")).toBe(true);
		expect(isExpectedImportTab("x", "https://x.com/home")).toBe(false);
		expect(isExpectedImportTab("x", "https://example.com/i/bookmarks")).toBe(
			false,
		);
	});

	test("selects a Reddit user's saved route and no general Reddit tab", () => {
		expect(
			isExpectedImportTab(
				"reddit",
				"https://www.reddit.com/user/anansi/saved/",
			),
		).toBe(true);
		expect(
			isExpectedImportTab("reddit", "https://www.reddit.com/r/selfhosted/"),
		).toBe(false);
	});

	test("selects only GitHub's signed-in stars route", () => {
		expect(isExpectedImportTab("github", "https://github.com/stars")).toBe(
			true,
		);
		expect(
			isExpectedImportTab(
				"github",
				"https://github.com/stars/jojomensah89/repositories?filter=all&page=2",
			),
		).toBe(true);
		expect(
			isExpectedImportTab("github", "https://github.com/stars/lists/work"),
		).toBe(false);
		expect(
			isExpectedImportTab(
				"github",
				"https://github.com/stars/jojomensah89/repositories?filter=others",
			),
		).toBe(false);
		expect(
			isExpectedImportTab("github", "https://github.com/stars?token=secret"),
		).toBe(false);
		expect(
			isExpectedImportTab("github", "https://github.com/anansi/anansi"),
		).toBe(false);
	});
});

describe("capture delivery ownership", () => {
	test("selects exactly one path per source", () => {
		expect(captureDeliveryMode(2, { x: true }, "x")).toBe("queue");
		expect(captureDeliveryMode(2, { x: false }, "x")).toBe("legacy");
		expect(captureDeliveryMode(1, { x: true }, "x")).toBe("legacy");
		expect(captureDeliveryMode(2, { reddit: true }, "x")).toBe("legacy");
		expect(captureDeliveryMode(2, { github: true }, "github")).toBe("queue");
	});
});

describe("held saves", () => {
	test("holds ids until each one is acknowledged", async () => {
		const { runs } = setup();

		await runs.recordPendingSave("x", "1900000000000000001");
		await runs.recordPendingSave("x", "1900000000000000002");

		expect(await runs.takePendingSaves("x")).toEqual([
			"1900000000000000001",
			"1900000000000000002",
		]);
		expect(await runs.ackPendingSave("x", "1900000000000000001")).toBe(true);
		expect(await runs.takePendingSaves("x")).toEqual([
			"1900000000000000002",
		]);
		expect(await runs.ackPendingSave("x", "missing")).toBe(false);
	});

	test("the same save observed twice is held once", async () => {
		const { runs } = setup();

		await runs.recordPendingSave("x", "1900000000000000001");
		await runs.recordPendingSave("x", "1900000000000000001");

		expect(await runs.takePendingSaves("x")).toEqual(["1900000000000000001"]);
		expect(await runs.ackPendingSave("x", "1900000000000000001")).toBe(true);
		expect(await runs.takePendingSaves("x")).toEqual([]);
	});

	test("survives a worker restart, because it is in the store", async () => {
		const { runs, store } = setup();
		await runs.recordPendingSave("x", "1900000000000000009");

		const revived = createSourceRuns({
			store,
			now: () => 20_000,
			createId: () => "run-revived",
		});

		expect(await revived.takePendingSaves("x")).toEqual([
			"1900000000000000009",
		]);
		await revived.ackPendingSave("x", "1900000000000000009");
	});

	test("a flood keeps the newest saves rather than the oldest", async () => {
		const { runs } = setup();
		for (let index = 0; index < 260; index++) {
			await runs.recordPendingSave("x", `id-${index}`);
		}

		const held = await runs.takePendingSaves("x");
		expect(held).toHaveLength(200);
		expect(held.at(-1)).toBe("id-259");
	});
});

describe("shared source-run coordination", () => {
	test("serializes event sequences across instances sharing one store", async () => {
		const { store } = setup();
		let sequence = 0;
		const first = createSourceRuns({
			store,
			now: () => 10_000,
			createId: () => `first-${++sequence}`,
		});
		const second = createSourceRuns({
			store,
			now: () => 10_000,
			createId: () => `second-${++sequence}`,
		});

		expect((await Promise.all([
			first.nextItemEventSequence("github"),
			second.nextItemEventSequence("github"),
		]))).toEqual([1, 2]);
	});

	test("holds the effect fence while a browser action is running", async () => {
		const { store, runs: first, setNow } = setup();
		const second = createSourceRuns({
			store,
			now: () => 10_000 + SOURCE_RUN_LEASE_MS * 2 + 1,
			createId: () => "replacement",
		});
		const begun = await first.begin("x");
		setNow(10_000 + SOURCE_RUN_LEASE_MS + 1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const effect = first.runIfCurrent("x", begun.run.runId, async () => {
			entered = true;
			await gate;
		});
		const replacement = second.begin("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(entered).toBe(true);
		release();
		expect(await effect).toBe(true);
		expect((await replacement).started).toBe(true);
	});

	test("does not dispose a tab claimed by a replacement", async () => {
		const { store, runs: first, setNow } = setup();
		const second = createSourceRuns({
			store,
			now: () => 10_000 + SOURCE_RUN_LEASE_MS + 1,
			createId: () => "replacement",
		});
		const begun = await first.begin("x");
		setNow(10_000 + SOURCE_RUN_LEASE_MS + 1);
		const replacement = await second.begin("x");
		await second.setActiveTab("x", replacement.run.runId, 77);
		let disposed = false;
		expect(
			await first.disposeUnclaimedTab("x", begun.run.runId, 77, async () => {
				disposed = true;
			}),
		).toBe(false);
		expect(disposed).toBe(false);
	});

	test("keeps replacement runs behind an owned-tab close", async () => {
		const { store, runs: first, setNow } = setup();
		const second = createSourceRuns({
			store,
			now: () => 10_000 + SOURCE_RUN_LEASE_MS * 2 + 1,
			createId: () => "replacement",
		});
		const begun = await first.begin("x");
		await first.setOwnedTabForRun("x", begun.run.runId, 88);
		setNow(10_000 + SOURCE_RUN_LEASE_MS + 1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const close = first.closeOwnedTabForRun("x", begun.run.runId, 88, async () => {
			await gate;
		});
		const replacement = second.begin("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		expect(await close).toBe(true);
		expect((await replacement).started).toBe(true);
		expect((await second.current("x")).orphanedTabId).toBeUndefined();
	});
});

describe("item event identity", () => {
	test("allocates a collision-free sequence across worker restarts", async () => {
		const { runs, store } = setup();
		expect(await runs.nextItemEventSequence("github")).toBe(1);
		expect(await runs.nextItemEventSequence("github")).toBe(2);

		const revived = createSourceRuns({
			store,
			now: () => 20_000,
			createId: () => "run-revived",
		});
		expect(await revived.nextItemEventSequence("github")).toBe(3);
		expect(await revived.nextItemEventSequence("reddit")).toBe(1);
	});
});

describe("resume cursor", () => {
	test("a run begins where the last acknowledged page left off", async () => {
		const { runs } = setup();
		await runs.begin("x");
		await runs.setCursor("x", "cursor-page-9");
		await runs.finish("x");

		const next = await runs.begin("x");
		expect(next.run.cursor).toBe("cursor-page-9");
	});

	test("a walk that reached the end starts fresh next time", async () => {
		const { runs } = setup();
		await runs.begin("x");
		await runs.setCursor("x", "cursor-page-9");
		// The final page carries no cursor: there is nothing after it.
		await runs.setCursor("x", null);
		await runs.finish("x");

		const next = await runs.begin("x");
		expect(next.run.cursor).toBeUndefined();
	});
});

describe("initial import completion", () => {
	test("is due until successful completion survives a restart", async () => {
		const { runs, store, setNow } = setup();
		expect(await runs.initialImportDue("github")).toBe(true);

		await runs.begin("github");
		await runs.finish("github");
		expect(await runs.initialImportDue("github")).toBe(true);

		setNow(25_000);
		await runs.completeInitialImport("github");
		const revived = createSourceRuns({
			store,
			now: () => 30_000,
			createId: () => "run-revived",
		});
		expect(await revived.initialImportDue("github")).toBe(false);
		expect((await revived.current("github")).initialImportCompletedAt).toBe(
			25_000,
		);
	});

	test("failure, pause, and re-enable do not fabricate completion", async () => {
		const { runs } = setup();
		await runs.begin("github");
		await runs.noteError("github", "not_signed_in");
		await runs.stop("github");
		expect(await runs.initialImportDue("github")).toBe(true);

		await runs.begin("github");
		await runs.completeInitialImport("github");
		await runs.stop("github");
		expect(await runs.initialImportDue("github")).toBe(false);
	});

	test("manual runs remain allowed after the initial import", async () => {
		const { runs } = setup();
		await runs.completeInitialImport("github");
		const manual = await runs.begin("github");
		expect(manual.started).toBe(true);
	});

	test("distinguishes a live refresh from a full import", async () => {
		const { runs } = setup();
		const live = await runs.begin("github", "live");
		expect(live.run.runMode).toBe("live");
		await runs.finish("github");

		const full = await runs.begin("github", "full");
		expect(full.run.runMode).toBe("full");
	});
});
