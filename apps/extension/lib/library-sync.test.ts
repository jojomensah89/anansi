import { describe, expect, test } from "bun:test";
import { createLibrarySync, isLibraryPage, SYNC_SKIP_MS, TIKTOK_SYNC_SETTING } from "./library-sync.ts";

function setup(options: { enabled?: string[]; tiktok?: boolean; at?: number } = {}) {
	const stored = new Map<string, unknown>();
	if (options.tiktok) stored.set(TIKTOK_SYNC_SETTING, true);
	const state = { at: options.at ?? 1_800_000_000_000, started: [] as string[] };
	const sync = createLibrarySync({
		storage: {
			get: async (key) => stored.get(key),
			set: async (values) => { for (const [key, value] of Object.entries(values)) stored.set(key, value); },
		},
		now: () => state.at,
		enabledSources: async () => options.enabled ?? ["x", "reddit", "github", "tiktok", "web"],
		start: async (source) => { state.started.push(source); },
	});
	return { sync, state };
}

describe("library sync", () => {
	test("checks X, Reddit and GitHub by default, and TikTok only when opted in", async () => {
		const off = setup();
		await off.sync.libraryOpened();
		expect(off.state.started).toEqual(["x", "reddit", "github"]);
		const on = setup({ tiktok: true });
		await on.sync.libraryOpened();
		expect(on.state.started).toEqual(["x", "reddit", "github", "tiktok"]);
	});

	test("skips sources switched off on the server", async () => {
		const { sync, state } = setup({ enabled: ["reddit"] });
		await sync.libraryOpened();
		expect(state.started).toEqual(["reddit"]);
	});

	test("reloading inside the skip window starts nothing, and it reopens afterward", async () => {
		const { sync, state } = setup();
		await sync.libraryOpened();
		state.started.length = 0;
		state.at += SYNC_SKIP_MS - 1;
		await sync.libraryOpened();
		expect(state.started).toEqual([]);
		state.at += 1;
		await sync.libraryOpened();
		expect(state.started).toEqual(["x", "reddit", "github"]);
	});

	test("two opens at once start each source once", async () => {
		const { sync, state } = setup();
		await Promise.all([sync.libraryOpened(), sync.libraryOpened()]);
		expect(state.started).toEqual(["x", "reddit", "github"]);
	});

	test("a server request runs once", async () => {
		const { sync, state } = setup();
		const requestedAt = Math.floor(state.at / 1000) - 30;
		await sync.serverRequest(requestedAt);
		expect(state.started).toEqual(["x", "reddit", "github"]);
		state.started.length = 0;
		state.at += SYNC_SKIP_MS;
		await sync.serverRequest(requestedAt);
		expect(state.started).toEqual([]);
	});

	test("old, missing or malformed server requests start nothing", async () => {
		const { sync, state } = setup();
		const now = Math.floor(state.at / 1000);
		await sync.serverRequest(null);
		await sync.serverRequest("soon");
		await sync.serverRequest(now - 601);
		expect(state.started).toEqual([]);
	});

	test("one source failing does not stop the others", async () => {
		const started: string[] = [];
		const sync = createLibrarySync({
			storage: { get: async () => undefined, set: async () => {} },
			now: () => 1,
			enabledSources: async () => ["x", "reddit"],
			start: async (source) => { started.push(source); if (source === "x") throw new Error("no"); },
		});
		await sync.libraryOpened();
		expect(started).toEqual(["x", "reddit"]);
	});

	test("only the connected library's own pages count as opening it", () => {
		const server = "https://mine.example";
		expect(isLibraryPage("https://mine.example/sources", server)).toBe(true);
		expect(isLibraryPage("https://mine.example/api/stats", server)).toBe(false);
		expect(isLibraryPage("https://mine.example.evil.test/", server)).toBe(false);
		expect(isLibraryPage("https://mine.example/", undefined)).toBe(false);
		expect(isLibraryPage("not a url", server)).toBe(false);
	});
});

describe("explicit platform requests", () => {
  test("force bypasses the five-minute window", async () => {
    const {sync,state} = setup(); await sync.libraryOpened(); state.started.length = 0;
    await sync.syncNow(); expect(state.started).toEqual(["x","reddit","github"]);
  });
  test("server scope cannot add a TikTok tab without local opt-in", async () => {
    const {sync,state} = setup();
    await sync.platformRequests([{source:"tiktok", requestedAt:state.at/1000, forced:1}, {source:"reddit",requestedAt:state.at/1000,forced:0}]);
    expect(state.started).toEqual(["reddit"]);
  });
  test("duplicates, stale, future and unknown requests do nothing", async () => {
    const {sync,state} = setup(); const request = [{source:"github",requestedAt:state.at/1000,forced:1}];
    await sync.platformRequests(request); state.started.length=0; await sync.platformRequests(request);
    await sync.platformRequests([{source:"x",requestedAt:state.at/1000+1000},{source:"reddit",requestedAt:0},{source:"web",requestedAt:state.at/1000}]);
    expect(state.started).toEqual([]);
  });
});
