import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom } from "../lib/test-dom.ts";
import type * as Module from "./connected-clients.tsx";

/** Base UI decides at import time whether it can portal, so load it once a DOM exists. */
let mod: typeof Module;
let createRoot: typeof import("react-dom/client").createRoot;
let dom: ReturnType<typeof installDom>;
let root: Root;
let calls: Array<{ url: string; method: string; body?: string; credentials?: string }>;
const original = globalThis.fetch;
const now = Math.floor(Date.now() / 1000);

beforeEach(async () => {
	dom = installDom();
	({ createRoot } = await import("react-dom/client"));
	mod = await import("./connected-clients.tsx");
	root = createRoot(document.getElementById("root")!);
	calls = [];
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = original;
	dom.restore();
});

type Row = Module.Client;
const client = (over: Partial<Row>): Row => ({ id: "c1", name: "Cursor", kind: "app", scopes: "read", lastUse: now - 120, revokedAt: null, ...over });

/** A tiny /api/clients that remembers revokes, renames and permission changes. */
function serve(initial: Row[], legacyActive = false) {
	let rows = initial.map((r) => ({ ...r }));
	let legacy = legacyActive;
	globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
		const url = String(input);
		const method = init.method ?? "GET";
		calls.push({ url, method, body: init.body as string | undefined, credentials: init.credentials });
		const id = url.split("/")[3];
		if (url === "/api/clients" && method === "GET") return Response.json({ clients: rows, legacyActive: legacy });
		if (url === "/api/clients" && method === "POST") return Response.json({ id: "new", key: "ans_live_fixture_key" });
		if (url === "/api/clients/retire-legacy") { legacy = false; return Response.json({ ok: true }); }
		if (url.endsWith("/permissions")) {
			const write = JSON.parse(init.body as string).write as boolean;
			rows = rows.map((r) => (r.id === id ? { ...r, scopes: write ? "read,write" : "read" } : r));
			return Response.json({ ok: true });
		}
		if (method === "DELETE") { rows = rows.map((r) => (r.id === id ? { ...r, revokedAt: now } : r)); return Response.json({ ok: true }); }
		if (method === "PATCH") { rows = rows.map((r) => (r.id === id ? { ...r, name: JSON.parse(init.body as string).name } : r)); return Response.json({ ok: true }); }
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const render = async () => { await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(mod.ConnectedClients)))); await settle(); };
const button = (name: string) => [...document.querySelectorAll<HTMLElement>("button,[role=menuitem]")].find((b) => b.textContent?.trim() === name);
const press = async (el: HTMLElement | undefined | null) => {
	expect(el).toBeTruthy();
	await act(async () => {
		el!.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
		el!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
		el!.dispatchEvent(new dom.window.PointerEvent("pointerup", { bubbles: true, button: 0 }));
		el!.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
		el!.click();
	});
	await settle();
};
const rowText = () => [...document.querySelectorAll("tbody tr")].map((tr) => tr.textContent);

test("last used reads as a short relative time", () => {
	const at = 1_800_000_000;
	expect(mod.ago(null)).toBe("Never");
	expect(mod.ago(at - 20, at * 1000)).toBe("just now");
	expect(mod.ago(at - 240, at * 1000)).toBe("4 min ago");
	expect(mod.ago(at - 30 * 3600, at * 1000)).toBe("yesterday");
	expect(mod.ago(at - 12 * 86400, at * 1000)).toBe("12 days ago");
});

test("the table lists agents and browsers; the access switch calls the permissions endpoint", async () => {
	serve([
		client({ id: "a1", name: "Claude", scopes: "read,write" }),
		client({ id: "k1", name: "Research script", kind: "api" }),
		client({ id: "e1", name: "Brave on desktop", kind: "extension", scopes: "capture" }),
		client({ id: "p1", name: "Browser extension", kind: "pairing", scopes: "pairing" }),
	]);
	await render();
	const rows = rowText();
	expect(rows).toHaveLength(3);
	expect(rows[0]).toContain("Read and write");
	expect(rows[1]).toContain("Read only");
	expect(rows[2]).toContain("Save only");
	expect(document.body.textContent).toContain("3 active");
	expect(document.body.textContent).not.toContain("Browser extension");
	// Extensions have no switch: they can only save.
	expect(document.querySelectorAll('[role="switch"]')).toHaveLength(2);

	const research = document.querySelector<HTMLElement>('[role="switch"][aria-label="Allow changes for Research script"]')!;
	await act(async () => (research.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
	await settle();
	expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Allow Research script to make changes?");
	await press(button("Allow changes"));
	const patch = calls.find((c) => c.url === "/api/clients/k1/permissions");
	expect(patch).toMatchObject({ method: "PATCH", body: '{"write":true}', credentials: "same-origin" });
	expect(rowText()[1]).toContain("Read and write");

	const claude = document.querySelector<HTMLElement>('[role="switch"][aria-label="Allow changes for Claude"]')!;
	await act(async () => (claude.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
	await settle();
	expect(calls.find((c) => c.url === "/api/clients/a1/permissions")?.body).toBe('{"write":false}');
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test("revoking goes through the row menu and a confirmation, never straight away", async () => {
	serve([client({ id: "c1", name: "Cursor" })]);
	await render();
	await press(document.querySelector<HTMLElement>('[aria-label="More for Cursor"]'));
	await press(button("Revoke…"));
	const dialog = document.querySelector('[role="alertdialog"]');
	expect(dialog?.textContent).toContain("Revoke Cursor?");
	expect(dialog?.textContent).toContain("It loses access right away. Your saves stay");
	expect(calls.some((c) => c.method === "DELETE")).toBe(false);

	await press(button("Keep access"));
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	expect(calls.some((c) => c.method === "DELETE")).toBe(false);

	await press(document.querySelector<HTMLElement>('[aria-label="More for Cursor"]'));
	await press(button("Revoke…"));
	await press(button("Revoke access"));
	expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/clients/c1");
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	// Nothing active now: the empty state, with the revoked client tucked away.
	expect(document.body.textContent).toContain("No agents or browsers yet");
	expect(button("1 revoked")).toBeTruthy();
});

test("the old shared token retires only after its own warning", async () => {
	serve([], true);
	await render();
	expect(rowText()[0]).toContain("Old shared token");
	await press(button("Retire"));
	expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Retire the old shared token?");
	await press(button("Retire token"));
	expect(calls.find((c) => c.url === "/api/clients/retire-legacy")?.method).toBe("POST");
	expect(document.body.textContent).toContain("No agents or browsers yet");
});

test("creating an API key names it, then shows the key once", async () => {
	serve([]);
	await render();
	await press(button("Create key"));
	await press(button("API keyRead access for agents and scripts"));
	expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Create an API key");
	const input = document.querySelector<HTMLInputElement>("#new-client-name")!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
		setter.call(input, "Research assistant");
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	await press(document.querySelector<HTMLElement>('[role="dialog"] button[type="submit"]'));
	const post = calls.find((c) => c.method === "POST");
	expect(post?.body).toBe('{"kind":"api","name":"Research assistant"}');
	expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Copy your key now");
	expect(document.querySelector('[role="dialog"] code')?.textContent).toBe("ans_live_fixture_key");
});

test("a failed load says so and can be retried", async () => {
	let fail = true;
	globalThis.fetch = (async () => (fail ? new Response("{}", { status: 500 }) : Response.json({ clients: [], legacyActive: false }))) as unknown as typeof fetch;
	await render();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load connected clients");
	fail = false;
	await press(button("Try again"));
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(document.body.textContent).toContain("No agents or browsers yet");
});
