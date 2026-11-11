import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	LoadMoreSkeleton,
	PaletteResultsSkeleton,
	SavedViewsSkeleton,
	SettingsSkeleton,
} from "./skeleton.tsx";

test("a settings section loads as one accessible row", () => {
	const html = renderToStaticMarkup(createElement(SettingsSkeleton));
	expect(html).toContain(">Loading settings</span>");
	expect(html.match(/class="settings-row"/g)?.length).toBe(1);
	expect(html).toContain('class="bone"');
});

test("inline loading states keep their content shape", () => {
	const savedViews = renderToStaticMarkup(createElement(SavedViewsSkeleton, { count: 2 }));
	const palette = renderToStaticMarkup(createElement(PaletteResultsSkeleton, { count: 2 }));
	const more = renderToStaticMarkup(createElement(LoadMoreSkeleton));

	expect(savedViews).toContain(">Loading saved views</span>");
	expect(savedViews.match(/class="bone"/g)?.length).toBe(6);
	expect(palette).toContain(">Searching your library</span>");
	expect(palette.match(/class="bone"/g)?.length).toBe(8);
	expect(more).toContain(">Loading more results</span>");
	expect(more).toContain('class="bone"');
});
