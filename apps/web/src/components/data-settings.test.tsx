import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "../lib/test-dom.ts";
import { DataSettings, downloadLibraryExport, exportFileName } from "./data-settings.tsx";

let dom: ReturnType<typeof installDom>;
let root: Root;
let calls: Array<{ url: string; method: string; body?: string }>;
const originalFetch = globalThis.fetch;
const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
	dom = installDom();
	calls = [];
	root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = originalFetch;
	URL.createObjectURL = originalUrl.create;
	URL.revokeObjectURL = originalUrl.revoke;
	dom.restore();
});

function serve(routes: Record<string, () => Response>) {
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
		const handler = routes[url];
		return handler ? handler() : new Response("{}", { status: 404 });
	}) as typeof fetch;
}

const render = () => act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(DataSettings))));
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(name)) as HTMLButtonElement | undefined;

test("export files are named for the day they were taken", () => {
	expect(exportFileName(new Date("2026-11-10T08:00:00Z"))).toBe("anansi-library-2026-11-10.json");
});

test("export downloads the server's file and releases the object URL", async () => {
	serve({ "/api/export": () => new Response('{"items":[]}') });
	const clicked: Array<{ href: string; download: string }> = [];
	dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push({ href: this.href, download: this.download }); };
	let revoked = "";
	URL.createObjectURL = () => "blob:anansi-export";
	URL.revokeObjectURL = (href: string) => { revoked = href; };
	await downloadLibraryExport(new Date("2026-11-10T08:00:00Z"));
	expect(calls.map((c) => c.url)).toEqual(["/api/export"]);
	expect(clicked).toEqual([{ href: "blob:anansi-export", download: "anansi-library-2026-11-10.json" }]);
	expect(revoked).toBe("blob:anansi-export");
});

test("Your data offers export and restore, and a stopped restore can clear its empty session", async () => {
	serve({
		"/api/restore": () => Response.json({ restore: { status: "active", backupId: "backup-1", progress: { items: 0, tags: 0 } } }),
		"/api/restore/abort": () => Response.json({ aborted: true }),
	});
	await render();
	expect(document.body.textContent).toContain("Export library");
	expect(document.body.textContent).toContain("Only into an empty library");
	expect(button("Choose file")).toBeDefined();

	const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(input, "files", { configurable: true, value: [new File(["not json"], "broken.json", { type: "application/json" })] });
	await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

	const alert = document.querySelector('[role="alert"]');
	expect(alert?.textContent).toBe("Stopped: This file is not valid JSON.");
	expect(alert?.closest("[data-tone]")?.getAttribute("data-tone")).toBe("danger");
	await act(async () => button("Clear empty restore")!.click());
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
	expect(calls.find((c) => c.url === "/api/restore/abort")?.body).toBe('{"backupId":"backup-1"}');
	expect(document.body.textContent).toContain("Empty restore cleared");
	expect(button("Choose file")).toBeDefined();
});
