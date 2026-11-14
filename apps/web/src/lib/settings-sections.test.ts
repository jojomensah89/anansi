import { expect, test } from "bun:test";
import { settingsSection, settingsSectionForHash } from "./settings-sections.ts";

test("/settings opens Library, and old anchors land in the area that took them over", () => {
	expect(settingsSectionForHash("")).toBe("library");
	expect(settingsSectionForHash(undefined)).toBe("library");
	expect(settingsSectionForHash("#sync")).toBe("library");
	expect(settingsSectionForHash("#display")).toBe("library");
	expect(settingsSectionForHash("#ai")).toBe("ai");
	expect(settingsSectionForHash("sign-in")).toBe("security");
	expect(settingsSectionForHash("#data")).toBe("data");
	expect(settingsSectionForHash("#agents")).toBe("agents");
	expect(settingsSectionForHash("#nonsense")).toBe("library");
});

test("each area has a label for the breadcrumb; unknown ones have none", () => {
	expect(settingsSection("ai")?.label).toBe("AI");
	expect(settingsSection("security")?.label).toBe("Security");
	expect(settingsSection("billing")).toBeUndefined();
});
