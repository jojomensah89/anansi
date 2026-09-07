import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ConnectionGateSkeleton,
	LoadMoreSkeleton,
	PageSkeleton,
	PaletteResultsSkeleton,
	SavedViewsSkeleton,
	SettingsSkeleton,
} from "./skeleton.tsx";

test("page and gate loading states use accessible skeleton regions", () => {
	for (const [component, label] of [
		[PageSkeleton, "Loading page"],
		[ConnectionGateSkeleton, "Connecting to your library"],
		[SettingsSkeleton, "Loading settings"],
	] as const) {
		const html = renderToStaticMarkup(createElement(component));
		expect(html).toContain(`>${label}</span>`);
		expect(html).toContain('class="bone"');
	}
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
