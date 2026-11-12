import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { toast } from "sonner";
import { installDom } from "../lib/test-dom.ts";
import type * as Module from "./client-write-permission.tsx";

/** Base UI decides at import time whether it can portal, so load it once a DOM exists. */
let ClientWritePermission: typeof Module.ClientWritePermission;
let createRoot: typeof import("react-dom/client").createRoot;
let dom: ReturnType<typeof installDom>;
let root: Root;
const original = globalThis.fetch;
beforeEach(async () => {
	dom = installDom();
	({ createRoot } = await import("react-dom/client"));
	({ ClientWritePermission } = await import("./client-write-permission.tsx"));
	root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = original;
	dom.restore();
});

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const sw = () => document.querySelector<HTMLElement>('[role="switch"]');
const flip = () => (sw()!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
const byText = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

test("permission confirmation, pending, failure, disabling and ineligible rows", async () => {
	const client = { id: "fixture", name: "Research", kind: "api", scopes: "read", revokedAt: null as number | null };
	let changes = 0;
	let resolve!: (r: Response) => void;
	let request: { url: string; init: RequestInit } | undefined;
	globalThis.fetch = ((url: string, init: RequestInit) => { request = { url, init }; return new Promise<Response>((r) => (resolve = r)); }) as typeof fetch;
	const toastError = spyOn(toast, "error").mockImplementation(() => "");
	const render = (c = client) => act(async () => root.render(createElement(ClientWritePermission, { client: c, onChange: () => changes++ })));

	await render();
	expect(sw()!.getAttribute("aria-checked")).toBe("false");
	expect(document.body.textContent).toContain("Read only");

	// Turning changes on asks first and sends nothing until confirmed.
	await act(async () => flip());
	await settle();
	expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Allow Research to make changes?");
	expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("It can never delete");
	expect(request).toBeUndefined();

	await act(async () => byText("Allow changes")!.click());
	expect(request?.url).toBe("/api/clients/fixture/permissions");
	expect(request?.init.method).toBe("PATCH");
	expect(request?.init.credentials).toBe("same-origin");
	expect(request?.init.body).toBe('{"write":true}');
	expect((request?.init.headers as Record<string, string>).Authorization).toBeUndefined();
	expect(sw()!.hasAttribute("data-disabled")).toBe(true);
	expect(sw()!.getAttribute("aria-checked")).toBe("true");

	// A refusal rolls back, says so in a toast and keeps the dialog open to try again.
	await act(async () => resolve(new Response("{}", { status: 403 })));
	await settle();
	expect(sw()!.getAttribute("aria-checked")).toBe("false");
	expect(toastError).toHaveBeenCalledWith("Couldn’t change access for Research");
	expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	expect(document.querySelector('[role="alertdialog"] [role="alert"]')).toBeNull();
	toastError.mockRestore();

	await act(async () => byText("Allow changes")!.click());
	await act(async () => resolve(new Response("{}")));
	await settle();
	expect(changes).toBe(1);
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();

	// Turning changes off needs no confirmation.
	await render({ ...client, scopes: "read,write" });
	expect(sw()!.getAttribute("aria-checked")).toBe("true");
	expect(document.body.textContent).toContain("Read and write");
	await act(async () => flip());
	expect(request?.init.body).toBe('{"write":false}');
	await act(async () => resolve(new Response("{}")));
	await settle();
	expect(changes).toBe(2);

	for (const c of [{ ...client, revokedAt: 1 }, { ...client, kind: "extension" }, { ...client, kind: "pairing" }]) {
		await render(c);
		expect(sw()).toBeNull();
	}
});
