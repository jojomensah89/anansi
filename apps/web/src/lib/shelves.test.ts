import { describe, expect, test } from "bun:test";
import type { Shelf } from "./api.ts";
import {
	adjustCount, chunk, describeRule, dropIndex, hasRule, moveShelf, ruleFromFilters, sortShelves, suggestionToShelf, toggleMembership, visibleSuggestion,
} from "./shelves.ts";

const shelf = (id: string, position: number, over: Partial<Shelf> = {}): Shelf => ({
	id, name: id, color: null, icon: null, position, filters: {}, count: 10, createdAt: position, updatedAt: position, ...over,
});

describe("a rule in plain words", () => {
	const isTopic = (label: string) => ["News", "Design", "Hardware & Networking"].includes(label);

	test("one clause per field, sources named without their tails", () => {
		expect(describeRule({ source: ["reddit"], tag: ["Hardware & Networking"] }, isTopic)).toEqual(["Source is Reddit", "Topic is Hardware & Networking"]);
		expect(describeRule({ source: ["x", "github", "web"] })).toEqual(["Source is X, GitHub or Web"]);
	});

	test("topics and the owner's own tags read differently", () => {
		expect(describeRule({ tag: ["News", "to read"] }, isTopic)).toEqual(["Topic is News", "Tag is to read"]);
	});

	test("flags and search read as words", () => {
		expect(describeRule({ favorite: true, media: "video", removed: "only", query: " sourdough " })).toEqual(["Matches “sourdough”", "Has video", "Favorites", "Removed at source"]);
	});

	test("a rule that narrows nothing is a hand-filled shelf", () => {
		expect(hasRule({})).toBe(false);
		expect(hasRule({ source: [], tag: [] })).toBe(false);
		expect(hasRule(null)).toBe(false);
		expect(hasRule({ tag: ["Design"] })).toBe(true);
	});
});

test("the library's filters become a rule without paging, order or view state", () => {
	expect(ruleFromFilters({ source: ["reddit"], tag: [], author: undefined, removed: "include", query: "  ", order: "posted", limit: 60, cursor: "c", shelf: "s1" })).toEqual({ source: ["reddit"] });
	expect(ruleFromFilters({ tag: ["Design"], favorite: true, removed: "exclude", query: "type" })).toEqual({ tag: ["Design"], favorite: true, removed: "exclude", query: "type" });
});

describe("reordering", () => {
	const list = [shelf("a", 0), shelf("b", 1), shelf("c", 2), shelf("d", 3)];

	test("moving a shelf renumbers positions in the new order", () => {
		const next = moveShelf(list, "a", 2);
		expect(next.map((entry) => entry.id)).toEqual(["b", "c", "a", "d"]);
		expect(next.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
	});

	test("out-of-range targets clamp, and unknown ids change nothing", () => {
		expect(moveShelf(list, "d", -5).map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
		expect(moveShelf(list, "zz", 1).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
	});

	test("the rail sorts by position, then age", () => {
		expect(sortShelves([shelf("b", 1), shelf("a", 0), shelf("c", 1, { createdAt: -1 })]).map((entry) => entry.id)).toEqual(["a", "c", "b"]);
	});

	test("a dragged row lands where its centre is", () => {
		const rows = [0, 33, 66, 99].map((top) => ({ top, height: 32 }));
		expect(dropIndex(rows, 0, 16)).toBe(0);
		expect(dropIndex(rows, 0, 60)).toBe(1);
		expect(dropIndex(rows, 0, 120)).toBe(3);
		expect(dropIndex(rows, 3, 10)).toBe(0);
	});
});

describe("membership", () => {
	test("adding and removing toggles one id, never duplicating it", () => {
		expect(toggleMembership(["a"], "a", true)).toEqual(["a"]);
		expect(toggleMembership(undefined, "b", true)).toEqual(["b"]);
		expect(toggleMembership(["a", "b"], "a", false)).toEqual(["b"]);
	});

	test("counts move with the change and never go below zero", () => {
		const list = [shelf("a", 0, { count: 1 }), shelf("b", 1, { count: 5 })];
		expect(adjustCount(list, "a", -3).map((entry) => entry.count)).toEqual([0, 5]);
		expect(adjustCount(list, "b", 2).map((entry) => entry.count)).toEqual([1, 7]);
	});

	test("selections go to the server 500 ids at a time", () => {
		const ids = Array.from({ length: 1201 }, (_, index) => `i${index}`);
		expect(chunk(ids).map((part) => part.length)).toEqual([500, 500, 201]);
		expect(chunk([])).toEqual([]);
	});
});

describe("topic suggestions", () => {
	const design = { topic: "t-design", label: "Design", count: 221, filters: { tag: ["Design"] } };
	const music = { topic: "t-music", label: "Music", count: 54, filters: { tag: ["Music"] } };

	test("only one suggestion shows, skipping any dismissed", () => {
		expect(visibleSuggestion([design, music])).toBe(design);
		expect(visibleSuggestion([design, music], new Set(["t-design"]))).toBe(music);
		expect(visibleSuggestion([])).toBeNull();
		expect(visibleSuggestion(undefined)).toBeNull();
	});

	test("Create uses the topic as the rule, its colour and a fitting icon", () => {
		expect(suggestionToShelf(design)).toEqual({ name: "Design", color: "amber", icon: "palette", filters: { tag: ["Design"] } });
		expect(suggestionToShelf({ ...music, label: "Something new", filters: { tag: ["Something new"] } }).icon).toBe("folder");
	});
});
