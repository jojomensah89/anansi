import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemDetail } from "@anansi/db";
import type { ItemRow } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import { extensionStatus } from "../lib/source-state.ts";
import { Card } from "./card.tsx";
import { Detail } from "./detail.tsx";
import { StatusDot } from "./status-dot.tsx";

function detailItem(overrides: Partial<ItemDetail> = {}) {
	return {
		id: "inspector", url: "https://x.com/cj/status/1", source: "x", author: "cj", authorName: "CJ", authorAvatar: null,
		title: null, fullText: "Near instant VMs for every project folder.", articleText: null, articleFormat: "plain", contentTruncated: false,
		highlights: [], note: "", favorite: true, archived: false, tags: ["Design", "Tools"],
		tagMeta: [{ label: "Design", color: "#ffcc00" }, { label: "Tools", color: "#6b7280" }],
		postedAt: 1794220000, savedAt: 1794220000, savedAtExact: true, platformSaved: true, removedFromSourceAt: null,
		metrics: {}, media: [], links: [], quoted: null, thread: [],
		...overrides,
	} as unknown as ItemDetail;
}

function renderDetail(item: ItemDetail) {
	const client = new QueryClient();
	client.setQueryData(libraryKeys.detail(item.id), item);
	return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Detail, { id: item.id, onClose: () => {} })));
}

test("inspector actions are labelled icon buttons, favorite shows its pressed state", () => {
	const html = renderDetail(detailItem());
	const bar = html.slice(html.indexOf('role="toolbar"'), html.indexOf("</header>") > 0 ? html.indexOf("<header") : undefined);
	for (const label of ["Remove from favorites", "Archive", "Open original", "Close item detail"]) expect(bar).toContain(`aria-label="${label}"`);
	expect(bar).toMatch(/aria-label="Remove from favorites"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Remove from favorites"/);
	expect(bar).toMatch(/<a[^>]*href="https:\/\/x\.com\/cj\/status\/1"[^>]*target="_blank"/);
	// Icons, not words or glyphs.
	for (const removed of ["☆", "★", "↗", "Favorited", "Open original ↗", "Save note"]) expect(html).not.toContain(removed);
	expect(bar.match(/<svg/g)?.length).toBe(4);
});

test("inspector favorite toggles its label and pressed state; archive becomes unarchive", () => {
	const html = renderDetail(detailItem({ favorite: false, archived: true }));
	expect(html).toMatch(/aria-label="Add to favorites"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="Add to favorites"/);
	expect(html).toContain('aria-label="Unarchive"');
	expect(html).not.toContain('aria-label="Archive"');
});

test("inspector note saves itself: no save button, a live status region instead", () => {
	const html = renderDetail(detailItem());
	expect(html).not.toContain("Save note");
	expect(html).toMatch(/id="item-note-status"[^>]*role="status"|role="status"[^>]*id="item-note-status"/);
	expect(html).toContain('aria-describedby="item-note-status"');
});

test("tag chips carry no stored colour on cards or in the inspector", () => {
	const card = renderToStaticMarkup(createElement(Card, { item: { id: "c", source: "x", excerpt: "Saved", author: "a", tags: [{ label: "Design", color: "#ffcc00" }, { label: "Tools", color: "#22c55e" }] } as ItemRow }));
	const inspector = renderDetail(detailItem());
	for (const html of [card, inspector]) {
		for (const label of ["Design", "Tools"]) expect(html).toMatch(new RegExp(`class="[^"]*anansi-tag-chip[^"]*"[^>]*>${label}<`));
		expect(html).not.toContain("#ffcc00");
		expect(html).not.toContain("#22c55e");
		expect(html).not.toContain("#6b7280");
		// A chip is the label alone: no inline style, no coloured marker inside it.
		for (const chip of html.match(/<span[^>]*anansi-tag-chip[^>]*>[^<]*<\/span>/g) ?? []) expect(chip).not.toContain("style=");
	}
	// The same add control in both places.
	expect(card).toMatch(/class="[^"]*anansi-tag-trigger"/);
	expect(inspector).toMatch(/class="[^"]*anansi-tag-trigger"/);
	expect(inspector).not.toContain("+ Add tags");
});

test("status dot states render distinct tones", () => {
	const health = (connection: "connected" | "disconnected" | "never_connected") => ({
		connection, extensionVersion: "1.0.0", lastSeenAt: 1, activeClients: 1,
		queue: { queued: 0, uploading: 0, retrying: 0, failed: 0 }, sources: {},
	});
	const render = (status: ReturnType<typeof extensionStatus>) => renderToStaticMarkup(createElement(StatusDot, { status }));
	expect(render(extensionStatus(health("connected")))).toContain('data-tone="ok"');
	expect(render(extensionStatus(health("connected"), true))).toContain('data-tone="accent"');
	expect(render(extensionStatus(health("disconnected")))).toContain('data-tone="warn"');
	expect(render(extensionStatus(health("never_connected")))).toContain('data-state="never"');
	expect(render(extensionStatus(health("never_connected")))).toContain('data-tone="muted"');
	expect(render(extensionStatus(health("connected")))).toContain('aria-hidden="true"');
	expect(render(extensionStatus(health("connected")))).not.toContain("style=");
});
