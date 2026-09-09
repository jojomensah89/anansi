import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GITHUB_URL, X_URL } from "../lib/links.ts";
import { RailSocialLinks } from "./rail.tsx";

test("rail footer exposes follow on X and github links", () => {
	const html = renderToStaticMarkup(createElement(RailSocialLinks));

	expect(html).toContain(`href="${X_URL}"`);
	expect(html).toContain(`href="${GITHUB_URL}"`);
	expect(html).toContain("Follow on X");
	expect(html).toContain("GitHub");
	expect(html).toContain('target="_blank"');
	expect(html).toContain('rel="noopener noreferrer"');
});
