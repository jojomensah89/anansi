import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldFilter, type Field, ValueList } from "./filters.tsx";

const OPTIONS = [
	{ value: "x", label: "X bookmarks", count: 271, icon: <svg data-mark="x" /> },
	{ value: "github", label: "GitHub stars", count: 31, icon: <svg data-mark="github" /> },
	{ value: "web", label: "Web pages & bookmarks", count: 557, icon: <svg data-mark="web" /> },
];

const SOURCE: Field = { key: "source", label: "Source", multi: true, icon: null, options: OPTIONS };

/** Each row's cells, by role, in order. */
function rowCells(html: string): string[][] {
	const rows = html.split('<label class="filter-option"').slice(1);
	return rows.map((row) =>
		[...row.matchAll(/data-slot="checkbox"|class="(filter-menu-icon|filter-option-label|filter-option-count)"/g)].map(
			(m) => m[1] ?? "checkbox",
		),
	);
}

test("Source menu rows share one grid: checkbox, mark, full label, count", () => {
	const html = renderToStaticMarkup(<ValueList field={SOURCE} values={["github"]} onToggle={() => {}} onClear={() => {}} />);
	// The columns are declared once on the list, so every row lines up.
	expect(html).toContain('class="filter-menu-list scroll" role="group" aria-label="Source" data-icons="true" data-counts="true"');
	expect(rowCells(html)).toEqual([
		["checkbox", "filter-menu-icon", "filter-option-label", "filter-option-count"],
		["checkbox", "filter-menu-icon", "filter-option-label", "filter-option-count"],
		["checkbox", "filter-menu-icon", "filter-option-label", "filter-option-count"],
	]);
	// Full labels, never shortened in markup.
	expect(html).toContain('<span class="filter-option-label">Web pages &amp; bookmarks</span>');
	expect(html).toContain('<span class="filter-option-count">557</span>');
	expect(html).toContain("<span>1 selected</span>");
});

test("a list without marks or counts drops those columns rather than leaving gaps", () => {
	const plain: Field = { ...SOURCE, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] };
	const html = renderToStaticMarkup(<ValueList field={plain} values={[]} onToggle={() => {}} onClear={() => {}} />);
	expect(html).not.toContain("data-icons");
	expect(html).not.toContain("data-counts");
	expect(rowCells(html)).toEqual([
		["checkbox", "filter-option-label"],
		["checkbox", "filter-option-label"],
	]);
});

test("the Source filter's trigger is a popover trigger, not a positioned shim", () => {
	const html = renderToStaticMarkup(<FieldFilter label="Source" options={OPTIONS} values={[]} onChange={() => {}} />);
	expect(html).toContain('data-slot="popover-trigger"');
	expect(html).toContain('aria-haspopup="dialog"');
	expect(html).toContain("Source</button>");
});
