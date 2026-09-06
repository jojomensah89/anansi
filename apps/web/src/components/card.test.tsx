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

test("card exposes colored tags and a private-note control", () => {
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
	expect(html).toContain("#22c55e22");
	expect(html).toContain("Open private note");
	expect(html).toContain("Add tags");
});
