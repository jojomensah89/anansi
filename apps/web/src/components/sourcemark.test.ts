import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceMark } from "./sourcemark.tsx";
import { sourceMarkColor } from "./sourcemark-colors.ts";

describe("source mark colors", () => {
	test("uses a distinct brand color for colored platforms", () => {
		expect(sourceMarkColor("reddit")).toBe("#ff4500");
		expect(sourceMarkColor("tiktok")).toBe("#25f4ee");
		expect(sourceMarkColor("web")).toBe("#7fa9cc");
	});

	test("keeps neutral marks visible without branding unknown sources", () => {
		expect(sourceMarkColor("x")).toBe("#e6ebef");
		expect(sourceMarkColor("unknown")).toBe("var(--text)");
	});

	test("applies the platform color to the rendered mark", () => {
		const html = renderToStaticMarkup(
			createElement(SourceMark, { source: "reddit", size: 12 }),
		);
		expect(html).toContain(`color:${sourceMarkColor("reddit")}`);
	});
});
