import { expect, test } from "bun:test";
import { isLibrarySyncCommand } from "./messages.ts";
const command = { anansi: "library-sync-now", messageVersion: 1 };
test("library commands require the connected origin and exact shape", () => {
	expect(
		isLibrarySyncCommand(command, "https://owner.test/", "https://owner.test"),
	).toBe(true);
	for (const url of [
		undefined,
		"https://evil.test/",
		"https://owner.test.evil.test/",
		"http://owner.test/",
	])
		expect(isLibrarySyncCommand(command, url, "https://owner.test")).toBe(
			false,
		);
	expect(
		isLibrarySyncCommand(
			{ ...command, source: "tiktok" },
			"https://owner.test/",
			"https://owner.test",
		),
	).toBe(false);
	expect(
		isLibrarySyncCommand(
			{ ...command, messageVersion: 2 },
			"https://owner.test/",
			"https://owner.test",
		),
	).toBe(false);
	expect(isLibrarySyncCommand(command, "https://owner.test/", undefined)).toBe(
		false,
	);
});
