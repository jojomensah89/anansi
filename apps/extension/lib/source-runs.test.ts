import { describe, expect, test } from "bun:test";
import type { SyncStateRecord } from "./idb-outbox.ts";
import {
	captureDeliveryMode,
	createSourceRuns,
	isExpectedImportTab,
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

	test("opens a dedicated TikTok tab until its verified Favorites route ships", () => {
		expect(isExpectedImportTab("tiktok", "https://www.tiktok.com/")).toBe(
			false,
		);
	});

	test("selects only GitHub's signed-in stars route", () => {
		expect(isExpectedImportTab("github", "https://github.com/stars")).toBe(
			true,
		);
		expect(
			isExpectedImportTab("github", "https://github.com/stars/lists/work"),
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
	test("holds an id until it is taken, and only once", async () => {
		const { runs } = setup();

		await runs.recordPendingSave("x", "1900000000000000001");
		await runs.recordPendingSave("x", "1900000000000000002");

		expect(await runs.takePendingSaves("x")).toEqual([
			"1900000000000000001",
			"1900000000000000002",
		]);
		expect(await runs.takePendingSaves("x")).toEqual([]);
	});

	test("the same save observed twice is held once", async () => {
		const { runs } = setup();

		await runs.recordPendingSave("x", "1900000000000000001");
		await runs.recordPendingSave("x", "1900000000000000001");

		expect(await runs.takePendingSaves("x")).toEqual(["1900000000000000001"]);
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
});
