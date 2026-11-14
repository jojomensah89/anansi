import { expect, test } from "bun:test";
import type { ItemRow } from "../lib/api.ts";
import { packColumns } from "./masonry.tsx";

const row = (id: string, media = 0) =>
	({ id, excerpt: "", media: Array.from({ length: media }, () => ({})) }) as unknown as ItemRow;

test("masonry tolerates an older quoted item without a media array", () => {
	const item = { id: "legacy-quote", excerpt: "A saved quote", quoted: {} } as ItemRow;
	expect(packColumns([item], 2)).toEqual([[item], []]);
});

test("each row reads in library order, whatever the card heights", () => {
	const items = [row("1", 4), row("2"), row("3"), row("4", 4), row("5"), row("6"), row("7")];
	const ids = packColumns(items, 3).map((column) => column.map((item) => item.id));
	expect(ids).toEqual([["1", "4", "7"], ["2", "5"], ["3", "6"]]);
});
