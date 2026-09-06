import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, avatarLabelFor, avatarTintFor, storedAvatarSource } from "./avatar.tsx";

describe("avatar fallback", () => {
	test("only local media and trusted provider avatars render as images", () => {
		expect(storedAvatarSource("https://example.com/avatar.png")).toBeNull();
		expect(storedAvatarSource("https://pbs.twimg.com/profile_images/1/avatar.png")).toBe("https://pbs.twimg.com/profile_images/1/avatar.png");
		expect(storedAvatarSource("http://avatars.githubusercontent.com/u/1")).toBeNull();
		expect(storedAvatarSource("http://127.0.0.1/admin")).toBeNull();
		expect(storedAvatarSource("/api/media/ab/cd/image.png")).toBe("/api/media/ab/cd/image.png");
	});
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
