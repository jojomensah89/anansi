import { afterEach, beforeEach, expect, test } from "bun:test";
import { MCP_TOOL_CATALOG, MCP_WRITE_TOOL_CATALOG } from "@anansi/mcp/catalog";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { consentTools } from "../lib/consent-tools.ts";
import { installDom } from "../lib/test-dom.ts";
import type * as Module from "./oauth-consent.tsx";

let ConsentView: typeof Module.ConsentView;
let createRoot: typeof import("react-dom/client").createRoot;
let dom: ReturnType<typeof installDom>;
let root: Root;
beforeEach(async () => {
	dom = installDom();
	({ createRoot } = await import("react-dom/client"));
	({ ConsentView } = await import("./oauth-consent.tsx"));
	root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
	await act(async () => root.unmount());
	dom.restore();
});

const read = MCP_TOOL_CATALOG.map((t) => t.name);
const write = MCP_WRITE_TOOL_CATALOG.map((t) => t.name);
const listed = (heading: string) => {
	const h = [...document.querySelectorAll("h2")].find((el) => el.textContent === heading);
	return h ? [...document.querySelectorAll(`[aria-labelledby="${h.id}"] li code`)].map((c) => c.textContent) : null;
};

test("consent grants read tools, and write tools only when the owner already allowed them", () => {
	expect(consentTools(false)).toEqual({ allowed: read, denied: write });
	expect(consentTools(true)).toEqual({ allowed: [...read, ...write], denied: [] });
	expect(read).toContain("search_saved");
	expect(write).toEqual(["add_tag", "remove_tag", "set_note", "save_link"]);
});

test("a new app sees every read tool it can use and every write tool it can't", async () => {
	const decisions: boolean[] = [];
	await act(async () => root.render(createElement(ConsentView, {
		request: { state: "ready", name: "Claude", destination: "https://claude.ai/api/mcp/auth_callback", write: false },
		onDecide: (allow: boolean) => decisions.push(allow),
	})));
	expect(document.querySelector("h1")?.textContent).toBe("Allow Claude to read your library?");
	expect(listed("It can use")).toEqual(read);
	expect(listed("Not allowed")).toEqual(write);
	expect(document.querySelector('[role="note"]')?.textContent).toContain("can’t verify this name");
	expect(document.body.textContent).toContain("https://claude.ai/api/mcp/auth_callback");
	const mcp = document.querySelector<HTMLAnchorElement>('a[href="/mcp"]');
	expect(mcp?.textContent).toBe("MCP server");
	expect(document.body.textContent).not.toContain("Settings");
	const buttons = [...document.querySelectorAll("button")];
	await act(async () => buttons.find((b) => b.textContent === "Deny")!.click());
	await act(async () => buttons.find((b) => b.textContent === "Allow")!.click());
	expect(decisions).toEqual([false, true]);
});

test("an app reconnecting with write access lists the write tools as allowed", async () => {
	await act(async () => root.render(createElement(ConsentView, {
		request: { state: "ready", name: "Cursor", destination: "cursor://anysphere.cursor-mcp/oauth/callback", write: true },
		onDecide: () => {},
	})));
	expect(document.querySelector("h1")?.textContent).toBe("Allow Cursor to use your library?");
	expect(listed("It can use")).toEqual([...read, ...write]);
	expect(listed("Not allowed")).toBeNull();
});

test("loading, invalid requests and a failed decision each say what happened", async () => {
	await act(async () => root.render(createElement(ConsentView, { request: { state: "loading" }, onDecide: () => {} })));
	expect(document.querySelector('[role="status"]')).not.toBeNull();
	expect(document.querySelector("button")).toBeNull();

	await act(async () => root.render(createElement(ConsentView, { request: { state: "invalid", message: "This app asked for more than read access, which Anansi can't grant." }, onDecide: () => {} })));
	expect(document.querySelector("h1")?.textContent).toBe("Can’t connect this app");
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("more than read access");
	expect(document.querySelector("button")).toBeNull();

	await act(async () => root.render(createElement(ConsentView, {
		request: { state: "ready", name: "Claude", destination: "https://claude.ai/cb", write: false },
		pending: "allow",
		error: "Couldn’t complete approval. Try connecting again",
		onDecide: () => {},
	})));
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t complete approval");
	const buttons = [...document.querySelectorAll("button")];
	expect(buttons.every((b) => b.disabled)).toBe(true);
	expect(buttons.map((b) => b.textContent)).toEqual(["Deny", "Allowing"]);
});
