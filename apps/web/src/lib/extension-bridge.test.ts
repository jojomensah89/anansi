import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "./test-dom.ts";
import { requestExtensionImport, requestExtensionSync } from "./extension-bridge.ts";

let dom: ReturnType<typeof installDom>;
let posted: Array<{ data: any; origin: string }>;
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
	dom = installDom();
	originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", { configurable: true, value: dom.window.location });
	posted = [];
	dom.window.postMessage = (data: unknown, origin: string) => posted.push({ data, origin });
});
afterEach(() => {
	if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
	else delete (globalThis as any).location;
	dom.restore();
});

/** What the extension's content script sends back on the page's window. */
function reply(data: Record<string, unknown>, origin = "http://localhost", source: unknown = dom.window) {
	const event = new dom.window.MessageEvent("message", { data, origin });
	Object.defineProperty(event, "source", { value: source });
	dom.window.dispatchEvent(event);
}

test("import request posts the source to this origin and resolves true on ok", async () => {
	const pending = requestExtensionImport("reddit");
	expect(posted).toHaveLength(1);
	const { data, origin } = posted[0]!;
	expect(origin).toBe("http://localhost");
	expect(data).toMatchObject({ anansi: "library-import-request", source: "reddit" });
	expect(typeof data.id).toBe("string");
	reply({ anansi: "library-import-response", id: "someone-else", ok: false });
	reply({ anansi: "library-import-response", id: data.id, ok: true }, "https://evil.example");
	reply({ anansi: "library-import-response", id: data.id, ok: true });
	expect(await pending).toBe(true);
});

test("import request resolves false when the extension says no", async () => {
	const pending = requestExtensionImport("x");
	reply({ anansi: "library-import-response", id: posted[0]!.data.id, ok: false });
	expect(await pending).toBe(false);
});

test("import request resolves false after three seconds of silence", async () => {
	const started = Date.now();
	const result = await requestExtensionImport("github");
	expect(result).toBe(false);
	expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
}, 6000);

test("a sync answer never settles an import request", async () => {
	const sync = requestExtensionSync();
	const syncId = posted[0]!.data.id;
	expect(posted[0]!.data.anansi).toBe("library-sync-request");
	reply({ anansi: "library-import-response", id: syncId, ok: true });
	reply({ anansi: "library-sync-response", id: syncId, ok: true });
	expect(await sync).toBe(true);
});
