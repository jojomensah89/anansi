import { expect, test } from "bun:test";
import type { ItemRow } from "../lib/api.ts";
import { packColumns } from "./masonry.tsx";

test("masonry tolerates an older quoted item without a media array", () => {
	const item = {
		id: "legacy-quote",
		excerpt: "A saved quote",
		quoted: {},
	} as ItemRow;

	expect(packColumns([item], 2, 320)).toEqual([[item], []]);
});
