import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemDetail } from "@anansi/db";
import { libraryKeys } from "../lib/library-query.ts";
import { Detail } from "./detail.tsx";

test("detail tags use the shared picker instead of a create-only form", () => {
	const item = {
		id: "detail-tags",
		url: "https://x.com/example/status/1",
		source: "x",
		author: "example",
		authorName: "Example",
		authorAvatar: null,
		title: "Saved item",
		fullText: "Saved text",
		articleText: null,
		articleFormat: "plain",
		contentTruncated: false,
		highlights: [],
		note: "",
		favorite: false,
		tags: ["research"],
		tagMeta: [{ label: "research", color: "#22c55e" }],
		archived: false,
		postedAt: null,
		savedAt: 1,
		savedAtExact: true,
		platformSaved: true,
		removedFromSourceAt: null,
		metrics: {},
		media: [],
		links: [],
		quoted: null,
		thread: [],
	} satisfies ItemDetail;
	const client = new QueryClient();
	client.setQueryData(libraryKeys.detail(item.id), item);
	const html = renderToStaticMarkup(
		createElement(QueryClientProvider, { client }, createElement(Detail, { id: item.id, onClose: () => {} })),
	);

	expect(html).toContain("research");
	expect(html).toContain('aria-label="Add tags"');
	expect(html).not.toContain('id="item-tag"');
});

test("detail names the source once, by its mark, and keeps accessible names for removed headings", () => {
	const item = {
		id: "detail-copy", url: "https://x.com/kwame/status/1", source: "x", author: "kwame", authorName: "Kwame Osei", authorAvatar: null,
		title: null, fullText: "The best tools leave room for your work.", articleText: null, articleFormat: "plain", contentTruncated: false,
		highlights: [], note: "", favorite: false, tags: [], tagMeta: [], archived: false, postedAt: 1794220000, savedAt: 1794220000,
		savedAtExact: true, platformSaved: true, removedFromSourceAt: null, metrics: {}, links: [], quoted: null, thread: [],
		media: [{ kind: "photo", originUrl: "https://example.invalid/a.png", storedKey: "a.png" }],
	} as unknown as ItemDetail;
	const client = new QueryClient();
	client.setQueryData(libraryKeys.detail(item.id), item);
	const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Detail, { id: item.id, onClose: () => {} })));

	for (const removed of ["Saved from", "X bookmarks", "Saved text", "Stored media", "Record and provenance", "keyword search"]) expect(html).not.toContain(removed);
	expect(html.match(/aria-label="X"/g)).toHaveLength(1);
	expect(html).toContain("@kwame");
	expect(html).toContain('aria-label="Media"');
	expect(html).toContain('aria-label="Open image 1"');
	expect(html).toContain('aria-label="Tags"');
	expect(html).toContain('placeholder="Add a private note"');
	expect(html).toMatch(/<label[^>]*for="item-note"[^>]*>Private note<\/label>/);
	expect(html).toContain("<summary>Details</summary>");
	expect(html).not.toMatch(/class="mono"/);
});
