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
		expect(sourceMarkColor("x")).toBe("var(--text)");
		expect(sourceMarkColor("unknown")).toBe("var(--text)");
	});

 test("renders brand layers and theme-aware ink", () => {
  const render = (source: string, extra = {}) => renderToStaticMarkup(createElement(SourceMark, {source, ...extra}));
  expect(render("reddit")).toContain("#FF4500");
  expect(render("reddit")).toContain('fill="white"');
  expect(render("tiktok")).toContain("#25F4EE");
  expect(render("tiktok")).toContain("#FE2C55");
  for (const source of ["x", "github", "tiktok"]) expect(render(source)).toContain("light-dark(#000, #fff)");
  expect(render("tiktok", {muted:true})).not.toContain("#25F4EE");
  expect(render("github")).toContain('aria-label="GitHub"');
  expect(render("github", {decorative:true})).toContain('aria-hidden="true"');
  expect(render("web", {faviconUrl:"/api/media/site.svg",size:20})).toContain('src="/api/media/site.svg"');
  expect(render("web")).toContain("lucide-globe");
 });
});
