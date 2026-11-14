import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { installDom } from "../lib/test-dom.ts";
import type * as DialogModule from "./shelf-dialog.tsx";
import type * as RailModule from "./rail-shelves.tsx";
import type * as PickerModule from "./shelf-picker.tsx";

/** Base UI decides at import time whether it can portal, so load it once a DOM exists. */
let dialogMod: typeof DialogModule;
let railMod: typeof RailModule;
let pickerMod: typeof PickerModule;
let query: typeof import("@tanstack/react-query");
let createRoot: typeof import("react-dom/client").createRoot;
let dom: ReturnType<typeof installDom>;
let root: Root;
let client: QueryClientType;
let calls: { url: string; method: string; body: any }[];
const original = globalThis.fetch;

const shelf = (id: string, name: string, position: number, filters = {}) => ({ id, name, color: "blue", icon: "book-open", position, filters, count: 3, createdAt: 0, updatedAt: 0 });

beforeEach(async () => {
	dom = installDom();
	({ createRoot } = await import("react-dom/client"));
	query = await import("@tanstack/react-query");
	dialogMod = await import("./shelf-dialog.tsx");
	railMod = await import("./rail-shelves.tsx");
	pickerMod = await import("./shelf-picker.tsx");
	root = createRoot(document.getElementById("root")!);
	client = new query.QueryClient({ defaultOptions: { queries: { retry: false } } });
	calls = [];
	const onShelves = new Set(["s1"]);
	globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
		const url = String(input);
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ url, method, body });
		if (url === "/api/shelves" && method === "POST") return Response.json({ shelf: { ...shelf("new", body.name, 9, body.filters), color: body.color, icon: body.icon } });
		if (url === "/api/shelves") return Response.json({ shelves: [shelf("s1", "Reading list", 0), shelf("s2", "Homelab", 1, { source: ["reddit"] })] });
		if (url.startsWith("/api/shelves/suggestions/dismiss")) return Response.json({ dismissed: true });
		if (url.startsWith("/api/shelves/suggestions")) return Response.json({ suggestions: [] });
		if (url.endsWith("/items")) {
			const id = url.split("/")[3]!;
			if (body.action === "add") onShelves.add(id);
			else onShelves.delete(id);
			return Response.json({ changed: body.itemIds.length, shelf: shelf(id, "x", 0) });
		}
		if (url.startsWith("/api/items/")) return Response.json({ id: "i1", shelves: [...onShelves] });
		if (url === "/api/tags") return Response.json({ tags: [{ label: "Design", color: "", count: 4, kind: "topic" }] });
		return Response.json({});
	}) as typeof fetch;
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = original;
	dom.restore();
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };
const render = async (element: ReturnType<typeof createElement>) => {
	await act(async () => root.render(createElement(query.QueryClientProvider, { client }, element)));
	await settle();
};
const byText = (text: string, selector = "button") => [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);
const type = async (input: HTMLInputElement, value: string) => {
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
};
const submit = async () => {
	await act(async () => document.querySelector<HTMLFormElement>(".shelf-form")!.requestSubmit());
	await settle();
};

test("creating a shelf without a rule sends an empty rule and says how to fill it", async () => {
	let saved: { id: string } | null = null;
	let closed = false;
	await render(createElement(dialogMod.ShelfDialog, { request: { onSaved: (s: { id: string }) => { saved = s; } }, currentRule: null, onClose: () => { closed = true; } }));
	expect(document.body.textContent).toContain("New shelf");
	expect(document.body.textContent).toContain("Add saves with Add to shelf, or save filters as a rule");
	expect(byText("Create")!.hasAttribute("disabled")).toBe(true);

	await type(document.querySelector<HTMLInputElement>(".shelf-form input[placeholder=Name]")!, "  Reading list  ");
	await act(async () => document.querySelector<HTMLElement>(".shelf-swatch[aria-label=Green]")!.click());
	await act(async () => document.querySelector<HTMLElement>(".shelf-icon-option[aria-label=star]")!.click());
	await submit();

	const post = calls.find((call) => call.url === "/api/shelves" && call.method === "POST")!;
	expect(post.body).toEqual({ name: "Reading list", color: "green", icon: "star", filters: {} });
	expect(saved!.id).toBe("new");
	expect(closed).toBe(true);
});

test("creating with the library's filters shows them in plain words; Remove rule drops them", async () => {
	client.setQueryData(["tags"], { tags: [{ label: "Design", kind: "topic", color: "", count: 4 }] });
	await render(createElement(dialogMod.ShelfDialog, { request: { rule: { source: ["reddit"], tag: ["Design"] } }, currentRule: { source: ["reddit"], tag: ["Design"] }, onClose: () => {} }));
	await settle();
	expect(document.querySelector(".shelf-rule-text")!.textContent).toBe("Source is Reddit · Topic is Design");
	// One topic: the shelf starts in that topic's colour and icon.
	expect(document.querySelector(".shelf-swatch[aria-checked=true]")!.getAttribute("aria-label")).toBe("Amber");
	expect(document.querySelector(".shelf-icon-option[aria-checked=true]")!.getAttribute("aria-label")).toBe("palette");

	await type(document.querySelector<HTMLInputElement>(".shelf-form input[placeholder=Name]")!, "Rack build");
	await submit();
	expect(calls.find((call) => call.method === "POST" && call.url === "/api/shelves")!.body.filters).toEqual({ source: ["reddit"], tag: ["Design"] });
});

test("removing the rule makes a hand-filled shelf, and the current filters can be put back", async () => {
	await render(createElement(dialogMod.ShelfDialog, { request: { rule: { source: ["reddit"] } }, currentRule: { source: ["reddit"] }, onClose: () => {} }));
	await act(async () => byText("Remove rule")!.click());
	expect(document.querySelector(".shelf-rule-text")).toBeNull();
	expect(document.body.textContent).toContain("Add saves with Add to shelf");
	await act(async () => byText("Use current filters")!.click());
	expect(document.querySelector(".shelf-rule-text")!.textContent).toBe("Source is Reddit");
});

test("the icon search narrows the grid, and arrow keys move the choice", async () => {
	await render(createElement(dialogMod.ShelfDialog, { request: {}, currentRule: null, onClose: () => {} }));
	await type(document.querySelector<HTMLInputElement>("input[aria-label='Search icons']")!, "food");
	expect([...document.querySelectorAll(".shelf-icon-option")].map((el) => el.getAttribute("aria-label"))).toEqual(["utensils"]);
	await type(document.querySelector<HTMLInputElement>("input[aria-label='Search icons']")!, "");
	const first = document.querySelector<HTMLElement>(".shelf-icon-option[aria-checked=true]")!;
	expect(first.getAttribute("aria-label")).toBe("folder");
	await act(async () => first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
	expect(document.querySelector(".shelf-icon-option[aria-checked=true]")!.getAttribute("aria-label")).toBe("bookmark");
});

test("the suggestion row creates a shelf from the topic, or goes away when dismissed", async () => {
	const suggestion = { topic: "t-design", label: "Design", count: 221, filters: { tag: ["Design"] } };
	let created: { name: string } | null = null;
	await render(createElement(railMod.SuggestionRow, { suggestion, onCreated: (s: { name: string }) => { created = s; } }));
	expect(document.querySelector(".rail-suggestion-text")!.textContent).toBe("Make a shelf from Design · 221");

	await act(async () => byText("Create")!.click());
	await settle();
	expect(calls.find((call) => call.method === "POST" && call.url === "/api/shelves")!.body).toEqual({ name: "Design", color: "amber", icon: "palette", filters: { tag: ["Design"] } });
	expect(created!.name).toBe("Design");

	await act(async () => document.querySelector<HTMLElement>("button[aria-label='Dismiss Design suggestion']")!.click());
	await settle();
	expect(calls.find((call) => call.url === "/api/shelves/suggestions/dismiss")!.body).toEqual({ topic: "t-design" });
});

test("the picker checks the shelves a save is on, and choosing one toggles it", async () => {
	await render(createElement(pickerMod.ShelfPicker, { itemIds: ["i1"], onDone: () => {} }));
	const rows = () => [...document.querySelectorAll<HTMLElement>(".shelf-picker-row")];
	expect(rows().map((row) => row.textContent)).toEqual(["Reading list3", "Homelab3", "New shelf…"]);
	expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);

	await act(async () => rows()[1]!.click());
	await settle();
	expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
	expect(calls.find((call) => call.url === "/api/shelves/s2/items")!.body).toEqual({ itemIds: ["i1"], action: "add" });

	await act(async () => rows()[0]!.click());
	await settle();
	expect(calls.find((call) => call.url === "/api/shelves/s1/items")!.body).toEqual({ itemIds: ["i1"], action: "remove" });
	expect(rows()[0]!.getAttribute("aria-selected")).toBe("false");
});

test("typing in the picker narrows the shelves and offers a new one by that name", () => {
	const list = [shelf("s1", "Reading list", 0), shelf("s2", "Homelab", 1)] as never;
	expect(pickerMod.pickerRows(list, "home").map((row) => row.label)).toEqual(["Homelab", "New shelf “home”"]);
	expect(pickerMod.pickerRows(list, "").map((row) => row.id)).toEqual(["s1", "s2", "new"]);
});
