import { expect, test } from "bun:test";
import { saveCount, topicEdited } from "../lib/topics.ts";

test("a built-in shows Reset only once its description differs from the shipped one", () => {
	expect(topicEdited({ builtIn: true, description: "Games", defaultDescription: "Games" })).toBe(false);
	expect(topicEdited({ builtIn: true, description: "Only speedruns", defaultDescription: "Games" })).toBe(true);
	expect(topicEdited({ builtIn: false, description: "Bread" })).toBe(false);
});

test("save counts read as words, with grouped digits", () => {
	expect(saveCount(1)).toBe("1 save");
	expect(saveCount(0)).toBe("0 saves");
	expect(saveCount(1204)).toBe(`${(1204).toLocaleString()} saves`);
});
