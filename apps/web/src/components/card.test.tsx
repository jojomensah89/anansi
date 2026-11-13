import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRow } from "../lib/api.ts";
import { Card } from "./card.tsx";

test("card tolerates an older quoted item without text or media", () => {
	const item = {
		id: "legacy-quote",
		source: "x",
		excerpt: "A saved quote",
		quoted: {},
	} as ItemRow;

	expect(() => renderToStaticMarkup(createElement(Card, { item }))).not.toThrow();
});

test("card shows tags as neutral chips and a private-note control", () => {
	const item = {
		id: "organized",
		source: "x",
		excerpt: "Saved text",
		author: "author",
		tags: [{ label: "research", color: "#22c55e" }],
		hasNote: true,
	} as ItemRow;
	const html = renderToStaticMarkup(createElement(Card, { item }));

	expect(html).toContain("research");
	expect(html).not.toContain("#22c55e22");
 expect(html).not.toContain("#22c55e");
	expect(html).toMatch(/class="[^"]*anansi-tag-chip[^"]*"[^>]*>research</);
	expect(html).toContain("Open private note");
	expect(html).toContain("Add tags");
});

test("a web card names its site once, with its favicon in the identity slot", () => {
	const item = {
		id: "page",
		source: "web",
		title: "Local-first software",
		excerpt: "Seven ideals",
		url: "https://www.inkandswitch.com/local-first/",
		savedAt: 1793836800,
		media: [{ kind: "favicon", key: "fav.png" }],
		tags: [],
	} as unknown as ItemRow;
	const html = renderToStaticMarkup(createElement(Card, { item }));
	expect(html.match(/inkandswitch\.com/g)).toHaveLength(1);
	// React's server renderer adds a preload <link> for each image, so count the images themselves.
	expect(html.match(/<img[^>]*fav\.png/g)).toHaveLength(1);
	expect(html).toContain("capture-card-site");
});

test("a card is an article with one open button, not a button wrapping buttons", () => {
	const item = { id: "a11y", source: "x", excerpt: "Saved text", author: "ama", tags: [] } as unknown as ItemRow;
	const html = renderToStaticMarkup(createElement(Card, { item }));
	expect(html.startsWith("<article")).toBe(true);
	expect(html).not.toContain('role="button"');
	expect(html).toMatch(/<button[^>]*aria-label="Open Saved text|<button[^>]*aria-label="Open ama/);
});
