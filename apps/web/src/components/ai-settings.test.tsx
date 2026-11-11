import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import type { AiSettingsResponse } from "../lib/api.ts";
import { installDom } from "../lib/test-dom.ts";
import type * as AiModule from "./ai-settings.tsx";

/**
 * Base UI decides at import time whether layout effects can run, so the
 * module is loaded only once a DOM exists; a static import would leave its
 * dialogs unable to portal under jsdom.
 */
let ai: typeof AiModule;
let createRoot: typeof import("react-dom/client").createRoot;
async function loadAi() {
	if (!ai) {
		const dom = installDom();
		({ createRoot } = await import("react-dom/client"));
		ai = await import("./ai-settings.tsx");
		dom.restore();
	}
	return ai;
}

const preview = (estimatedCredits: number, runtime: "cloudflare" | "local" = "cloudflare") => ({
	estimate: { itemCount: 10, totalChunks: estimatedCredits, newChunks: estimatedCredits, estimatedCredits },
	credits: { used: 0, limit: 0, remaining: 0, month: "Dec" },
	runtime,
});

test("credit caps accept grouped digits and reject anything else", async () => {
	const { parseCap } = await loadAi();
	expect(parseCap("10,000")).toBe(10_000);
	expect(parseCap("10 000")).toBe(10_000);
	expect(parseCap("10.000")).toBe(10_000);
	expect(parseCap("0")).toBeNull();
	expect(parseCap("-5")).toBeNull();
	expect(parseCap("2,000,000")).toBeNull();
	expect(parseCap("ten")).toBeNull();
});

test("indexing is refused only when Cloudflare credits run short", async () => {
	const { capShortfall } = await loadAi();
	expect(capShortfall(preview(500), 1000, 400)).toBeNull();
	expect(capShortfall(preview(700), 1000, 400)).toBe("Indexing needs 700 credits but only 600 are left this month. Raise the cap or wait for the reset");
	expect(capShortfall(preview(9_999, "local"), 1, 1)).toBeNull();
});

const settings = (patch: Partial<AiSettingsResponse["settings"]> = {}): AiSettingsResponse => ({
	settings: { semanticSearchEnabled: 1, semanticIndexPaused: 0, semanticBudgetLimit: 1000, semanticBudgetUsed: 400, semanticBudgetMonth: "1 Dec", semanticGeneration: 1, autoTaggingEnabled: 0, embeddingModel: "e", embeddingDimensions: 1, tagModel: "t", quotaPauseReason: null, lastRunAt: null, ...patch },
	progress: { pending: 0, failed: 0, complete: 0 },
	embeddingProgress: { pending: 0, failed: 0, complete: 0 },
	taggingProgress: { pending: 0, failed: 0, complete: 0 },
	semanticIndex: { indexed: 5, pending: 5, total: 10 },
	available: true,
	capabilities: { semanticSearch: true, autoTagging: true },
	runtime: "cloudflare",
	taxonomyVersion: "2026-11",
});

let dom: ReturnType<typeof installDom>;
let root: Root;
let calls: Array<{ url: string; method: string; body?: string }>;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
	await loadAi();
	dom = installDom();
	calls = [];
	root = createRoot(document.getElementById("root")!);
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
		if (url === "/api/ai/semantic-preview") return Response.json(preview(900));
		if (url === "/api/ai" && init?.method === "PATCH") return Response.json(settings({ semanticSearchEnabled: 0 }));
		return Response.json(settings());
	}) as typeof fetch;
});
afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = originalFetch;
	dom.restore();
});

function Harness({ initial }: { initial: AiSettingsResponse }) {
	const [data, setData] = useState<AiSettingsResponse | null>(initial);
	return data ? createElement(ai.AiSettings, { data, setData }) : null;
}
/** Dialogs portal in over a few ticks; let them land. */
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const byText = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const searchSwitch = () => document.querySelector<HTMLElement>('[role="switch"][aria-label="Search by meaning"]')!;
/** Base UI switches toggle through their hidden checkbox. */
const flip = () => (searchSwitch().parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).click();

test("turning search by meaning off asks first and saves nothing until confirmed", async () => {
	await act(async () => root.render(createElement(Harness, { initial: settings() })));
	await act(async () => flip());
	await settle();
	expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Turn off search by meaning?");
	expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

	await act(async () => byText("Keep it on")!.click());
	await settle();
	expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
	expect(searchSwitch().getAttribute("aria-checked")).toBe("true");

	await act(async () => flip());
	await settle();
	await act(async () => byText("Turn off")!.click());
	await settle();
	expect(calls.find((c) => c.method === "PATCH")?.body).toBe('{"semanticSearchEnabled":false}');
	expect(searchSwitch().getAttribute("aria-checked")).toBe("false");
});

test("flipping the switch on enables immediately and keeps the estimate as quiet info", async () => {
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
		if (url === "/api/ai/semantic-preview") return Response.json(preview(300));
		if (url === "/api/ai" && init?.method === "PATCH") return Response.json(settings());
		return Response.json(settings());
	}) as typeof fetch;
	await act(async () => root.render(createElement(Harness, { initial: settings({ semanticSearchEnabled: 0 }) })));
	await act(async () => flip());
	await settle();
	expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
	expect(calls.find((c) => c.method === "PATCH")?.body).toBe('{"semanticSearchEnabled":true,"semanticBudgetLimit":1000,"confirmSemanticBackfill":true}');
	expect(searchSwitch().getAttribute("aria-checked")).toBe("true");
	expect(document.body.textContent).toContain("10 saves · about 300 credits to index · cap 1,000");
	expect(document.body.textContent).toContain("5 indexed · 5 pending · 10 total");
});

test("an estimate above the remaining cap asks in a dialog and saves nothing until the cap is raised", async () => {
	await act(async () => root.render(createElement(Harness, { initial: settings({ semanticSearchEnabled: 0 }) })));
	await act(async () => flip());
	await settle();
	const dialog = document.querySelector('[role="alertdialog"]');
	expect(dialog?.textContent).toContain("The cap is too low to index everything");
	expect(dialog?.textContent).toContain("Raise the cap to 1,300");
	expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
	expect(searchSwitch().getAttribute("aria-checked")).toBe("false");

	await act(async () => byText("Cancel")!.click());
	await settle();
	expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

	await act(async () => flip());
	await settle();
	await act(async () => byText("Raise cap")!.click());
	await settle();
	expect(calls.find((c) => c.method === "PATCH")?.body).toBe('{"semanticSearchEnabled":true,"semanticBudgetLimit":1300,"confirmSemanticBackfill":true}');
});
