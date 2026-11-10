import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRow } from "../lib/api.ts";
import { GithubRepoCard, githubLanguageColor } from "./github-repo-card.tsx";

const repo = (overrides: Partial<ItemRow> = {}): ItemRow => ({
  id: "repo-1",
  url: "https://github.com/Vyom-26/BMX_Racer",
  author: "Vyom-26",
  authorName: "Vyom-26",
  authorAvatar: null,
  title: "Vyom-26/BMX_Racer",
  excerpt: "A cel-shaded downhill BMX racing game.",
  postedAt: 1_757_000_000,
  savedAt: 1_757_000_000,
  savedAtExact: 1,
  source: "github",
  score: 0,
  saveOrder: null,
  metrics: { openIssues: 0, stars: 58, forks: 17, watchers: 3 },
  language: "TypeScript",
  ...overrides,
});

describe("GitHub repository card", () => {
  test("maps known languages and keeps unknown ones neutral", () => {
    expect(githubLanguageColor("TypeScript")).toBe("#3178c6");
    expect(githubLanguageColor("not-a-language")).toBe("#c8d0da");
    expect(githubLanguageColor(null)).toBe("#c8d0da");
  });

  test("restores the white social preview and original hierarchy with stored metadata", () => {
    const html = renderToStaticMarkup(createElement(GithubRepoCard, { item: repo() }));

    expect(html).toContain("Vyom-26/");
    expect(html).toContain("BMX_Racer");
    expect(html).not.toContain("<img");
    expect(html).toContain("Issues");
    expect(html).toContain("Stars");
    expect(html).toContain("Forks");
    expect(html).toContain(`background:${githubLanguageColor("TypeScript")}`);
    expect(html).not.toContain("Contributors");
    expect(html).toContain("background:#fff");
    expect(html).toContain("border:1px solid #d8dee4");
    // The original card: a bold owner/repo title line between the author
    // header and the description, then a monospace URL line in the panel.
    const title = html.indexOf(">Vyom-26/BMX_Racer<");
    expect(title).toBeGreaterThan(html.indexOf(">Vyom-26<"));
    expect(title).toBeLessThan(html.indexOf("A cel-shaded"));
    expect(html.slice(0, title)).toMatch(/font-weight:700[^>]*$/);
    expect(html).toContain("github.com/Vyom-26/BMX_Racer");
    expect(html.indexOf("github.com/Vyom-26/BMX_Racer")).toBeGreaterThan(html.indexOf("A cel-shaded"));
    expect(html).toMatch(/class="mono"[^>]*>github\.com\/Vyom-26\/BMX_Racer</);
    const sizes = [...html.matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    expect(html.match(/data-source=/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

	test("renders a neutral strip when language metadata is absent", () => {
    const html = renderToStaticMarkup(createElement(GithubRepoCard, { item: repo({ language: null }) }));

    expect(html).not.toContain("TypeScript");
		expect(html).toContain("Language unavailable");
	});

	test("shows Private only when that visibility was stored", () => {
		const privateHtml = renderToStaticMarkup(
			createElement(GithubRepoCard, {
				item: repo({ visibility: "private" }),
			}),
		);
		const unknownHtml = renderToStaticMarkup(
			createElement(GithubRepoCard, { item: repo() }),
		);

		expect(privateHtml).toContain("Private");
		expect(unknownHtml).not.toContain("Private");
	});
});
