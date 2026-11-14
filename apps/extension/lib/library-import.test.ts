import { afterEach, describe, expect, test } from "bun:test";
import { libraryBridgeScript } from "./library-bridge-script.ts";
import { isLibraryImportCommand, startLibraryImport, type LibraryImportDependencies } from "./library-import.ts";

const ORIGIN = "https://owner.test";
const command = { anansi: "library-import", messageVersion: 1, source: "tiktok" };
const tab = { url: `${ORIGIN}/`, frameId: 0, fromTab: true };

function deps(overrides: Partial<LibraryImportDependencies> = {}) {
	const started: string[] = [];
	const dependencies: LibraryImportDependencies = {
		connectedOrigin: async () => ORIGIN,
		enabledSources: async () => ["x", "reddit", "github", "tiktok"],
		start: async (source) => {
			started.push(source);
		},
		...overrides,
	};
	return { dependencies, started };
}

describe("isLibraryImportCommand", () => {
	test("accepts the exact shape from the connected library's top frame", () => {
		expect(isLibraryImportCommand(command, `${ORIGIN}/library`, ORIGIN, 0)).toBe(true);
		for (const source of ["x", "reddit", "github"])
			expect(isLibraryImportCommand({ ...command, source }, `${ORIGIN}/`, ORIGIN, 0)).toBe(true);
	});

	test("refuses other origins, frames and endpoints", () => {
		for (const url of [undefined, "https://evil.test/", "https://owner.test.evil.test/", "http://owner.test/", `${ORIGIN}/api/x`, `${ORIGIN}/mcp`])
			expect(isLibraryImportCommand(command, url, ORIGIN, 0)).toBe(false);
		expect(isLibraryImportCommand(command, `${ORIGIN}/`, ORIGIN, 1)).toBe(false);
		expect(isLibraryImportCommand(command, `${ORIGIN}/`, undefined, 0)).toBe(false);
	});

	test("refuses unknown sources and extra or missing fields", () => {
		for (const source of ["web", "chrome", "TIKTOK", "", 1, null])
			expect(isLibraryImportCommand({ ...command, source }, `${ORIGIN}/`, ORIGIN, 0)).toBe(false);
		expect(isLibraryImportCommand({ ...command, extra: true }, `${ORIGIN}/`, ORIGIN, 0)).toBe(false);
		expect(isLibraryImportCommand({ anansi: "library-import", messageVersion: 1 }, `${ORIGIN}/`, ORIGIN, 0)).toBe(false);
		expect(isLibraryImportCommand({ ...command, messageVersion: 2 }, `${ORIGIN}/`, ORIGIN, 0)).toBe(false);
		expect(isLibraryImportCommand({ ...command, anansi: "library-sync-now" }, `${ORIGIN}/`, ORIGIN, 0)).toBe(false);
	});
});

describe("startLibraryImport", () => {
	test("starts the full import and answers before the run ends", async () => {
		let finish: () => void = () => {};
		const { dependencies, started } = deps({
			start: (source) => {
				started.push(source);
				return new Promise<void>((resolve) => {
					finish = resolve;
				});
			},
		});
		expect(await startLibraryImport(command, tab, dependencies)).toEqual({ ok: true });
		expect(started).toEqual(["tiktok"]);
		finish();
	});

	test("refuses when not paired", async () => {
		const { dependencies, started } = deps({ connectedOrigin: async () => undefined });
		expect(await startLibraryImport(command, tab, dependencies)).toEqual({ ok: false });
		expect(started).toEqual([]);
	});

	test("refuses a source the server has switched off, or capture off", async () => {
		const off = deps({ enabledSources: async () => ["x"] });
		expect(await startLibraryImport(command, tab, off.dependencies)).toEqual({ ok: false });
		expect(off.started).toEqual([]);
		const disabled = deps({ enabledSources: async () => null });
		expect(await startLibraryImport(command, tab, disabled.dependencies)).toEqual({ ok: false });
		const broken = deps({ enabledSources: async () => Promise.reject(new Error("offline")) });
		expect(await startLibraryImport(command, tab, broken.dependencies)).toEqual({ ok: false });
	});

	test("refuses anything not from a tab of the library", async () => {
		const { dependencies, started } = deps();
		expect(await startLibraryImport(command, { ...tab, fromTab: false }, dependencies)).toEqual({ ok: false });
		expect(await startLibraryImport(command, { ...tab, url: "https://evil.test/" }, dependencies)).toEqual({ ok: false });
		expect(await startLibraryImport({ ...command, source: "nope" }, tab, dependencies)).toEqual({ ok: false });
		expect(started).toEqual([]);
	});

	test("a start that later fails does not reject the reply", async () => {
		const { dependencies } = deps({ start: async () => Promise.reject(new Error("tab closed")) });
		expect(await startLibraryImport(command, tab, dependencies)).toEqual({ ok: true });
	});
});

describe("library bridge script", () => {
	const saved = {
		window: (globalThis as Record<string, unknown>).window,
		location: (globalThis as Record<string, unknown>).location,
		chrome: (globalThis as Record<string, unknown>).chrome,
	};
	afterEach(() => {
		Object.assign(globalThis, saved);
		delete (globalThis as Record<string, unknown>).__anansiSyncBridge;
	});

	function install(reply: (message: Record<string, unknown>) => Promise<unknown>) {
		const listeners = new Set<(event: MessageEvent) => void>();
		const posted: unknown[] = [];
		const sent: unknown[] = [];
		const fakeWindow = {
			addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
			removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
			postMessage: (message: unknown, origin: string) => posted.push({ message, origin }),
		};
		Object.assign(globalThis, {
			window: fakeWindow,
			location: { origin: ORIGIN },
			chrome: {
				runtime: {
					sendMessage: (message: Record<string, unknown>) => {
						sent.push(message);
						return reply(message);
					},
				},
			},
		});
		libraryBridgeScript();
		const dispatch = (data: unknown, overrides: Partial<{ source: unknown; origin: string }> = {}) => {
			for (const listener of listeners)
				listener({ source: fakeWindow, origin: ORIGIN, data, ...overrides } as unknown as MessageEvent);
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		return { dispatch, posted, sent, settle, listeners };
	}

	test("relays an import request and answers with the worker's result", async () => {
		const bridge = install(async () => ({ ok: true }));
		bridge.dispatch({ anansi: "library-import-request", id: "a1", source: "tiktok" });
		await bridge.settle();
		expect(bridge.sent).toEqual([{ anansi: "library-import", messageVersion: 1, source: "tiktok" }]);
		expect(bridge.posted).toEqual([{ message: { anansi: "library-import-response", id: "a1", ok: true }, origin: ORIGIN }]);
	});

	test("answers ok false when the worker refuses or fails", async () => {
		const refused = install(async () => ({ ok: false }));
		refused.dispatch({ anansi: "library-import-request", id: "b", source: "x" });
		await refused.settle();
		expect(refused.posted).toEqual([{ message: { anansi: "library-import-response", id: "b", ok: false }, origin: ORIGIN }]);

		const failing = install(async () => Promise.reject(new Error("no receiver")));
		failing.dispatch({ anansi: "library-import-request", id: "c", source: "x" });
		await failing.settle();
		expect(failing.posted).toEqual([{ message: { anansi: "library-import-response", id: "c", ok: false }, origin: ORIGIN }]);
	});

	test("rejects a malformed source without asking the worker", async () => {
		const bridge = install(async () => ({ ok: true }));
		bridge.dispatch({ anansi: "library-import-request", id: "d", source: { toString: () => "x" } });
		bridge.dispatch({ anansi: "library-import-request", id: "e", source: "x".repeat(40) });
		await bridge.settle();
		expect(bridge.sent).toEqual([]);
		expect(bridge.posted.map((entry) => (entry as { message: { ok: boolean } }).message.ok)).toEqual([false, false]);
	});

	test("ignores other windows and origins, and keeps the sync round trip", async () => {
		const bridge = install(async () => ({ ok: true }));
		bridge.dispatch({ anansi: "library-import-request", id: "f", source: "x" }, { origin: "https://evil.test" });
		bridge.dispatch({ anansi: "library-import-request", id: "g", source: "x" }, { source: {} });
		bridge.dispatch({ anansi: "library-sync-request", id: "h" });
		await bridge.settle();
		expect(bridge.sent).toEqual([{ anansi: "library-sync-now", messageVersion: 1 }]);
		expect(bridge.posted).toEqual([{ message: { anansi: "library-sync-response", id: "h", ok: true }, origin: ORIGIN }]);
	});

	test("re-injecting replaces the old listener", () => {
		const bridge = install(async () => ({ ok: true }));
		libraryBridgeScript();
		expect(bridge.listeners.size).toBe(1);
	});
});
