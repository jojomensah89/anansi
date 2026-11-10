import { expect, test } from "bun:test";
import { authorHandleLine } from "./author-handle.ts";

test("an author tile shows a handle only when it adds to the name", () => {
	expect(authorHandleLine({ authorName: "Jimmy Reilly", authorHandle: "thejimmyreilly" })).toBe("@thejimmyreilly");
	// Web authors are their domain: the name already says it.
	expect(authorHandleLine({ authorName: "github.com", authorHandle: "github.com" })).toBeNull();
	expect(authorHandleLine({ authorName: "GitHub.com", authorHandle: "@github.com" })).toBeNull();
	expect(authorHandleLine({ authorName: null, authorHandle: "anansi" })).toBeNull();
	expect(authorHandleLine({ authorName: "Anansi", authorHandle: null })).toBeNull();
});
