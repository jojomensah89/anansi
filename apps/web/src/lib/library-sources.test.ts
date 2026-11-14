import { expect, test } from "bun:test";
import { VISIBLE_LIBRARY_SOURCES } from "@anansi/sources";
import { LIBRARY_SOURCES, sourceLabel } from "./api.ts";

test("the library lists every visible source, so a new one cannot go missing", () => {
	expect([...LIBRARY_SOURCES].sort()).toEqual([...VISIBLE_LIBRARY_SOURCES].sort());
});

test("every library source has a readable label", () => {
	for (const source of LIBRARY_SOURCES) expect(sourceLabel(source)).not.toBe(source);
});
