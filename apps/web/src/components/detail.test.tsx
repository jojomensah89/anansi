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
		tagMeta: [{ label: "research", color: "#22c55e", count: 1 }],
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
