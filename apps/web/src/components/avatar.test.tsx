import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, avatarLabelFor, avatarTintFor } from "./avatar.tsx";

describe("avatar fallback", () => {
	test("normalizes a handle for the displayed initial", () => {
		expect(avatarLabelFor(" @BrightUser ")).toBe("BrightUser");
		expect(avatarLabelFor(null)).toBe("");
	});

	test("keeps the same author color stable", () => {
		expect(avatarTintFor("BrightUser")).toBe(avatarTintFor("BrightUser"));
		expect(avatarTintFor("BrightUser")).not.toBe(avatarTintFor("AnotherUser"));
	});

	test("renders the initial on the derived color", () => {
		const html = renderToStaticMarkup(
			createElement(Avatar, { seed: "@BrightUser", size: 22 }),
		);
		expect(html).toContain(">B</span>");
		expect(html).toContain(`background:${avatarTintFor("BrightUser")}`);
	});
});
