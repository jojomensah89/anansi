import { describe, expect, test } from "bun:test";
import { createRunDeadlines } from "./run-deadline.ts";

function setup() {
	const pending = new Map<number, () => void>();
	let next = 0;
	const deadlines = createRunDeadlines<number>({
		schedule: (run) => {
			pending.set(++next, run);
			return next;
		},
		cancel: (timer) => pending.delete(timer),
	});
	const fireAll = () => {
		for (const run of [...pending.values()]) run();
		pending.clear();
	};
	return { deadlines, pending, fireAll };
}

describe("createRunDeadlines", () => {
	test("expires a run that makes no progress", () => {
		const h = setup();
		let expired = 0;
		h.deadlines.start("run", 1000, () => expired++);
		h.fireAll();
		expect(expired).toBe(1);
	});

	test("each page restarts the limit, so a long import keeps running", () => {
		const h = setup();
		let expired = 0;
		h.deadlines.start("run", 1000, () => expired++);
		for (let page = 0; page < 50; page++) h.deadlines.progress("run");
		expect(h.pending.size).toBe(1);
		expect(expired).toBe(0);
		h.fireAll();
		expect(expired).toBe(1);
	});

	test("a page cannot revive a run that already expired, or affect another run", () => {
		const h = setup();
		h.deadlines.start("run", 1000, () => {});
		h.fireAll();
		h.deadlines.progress("run");
		h.deadlines.progress("other");
		expect(h.pending.size).toBe(0);
	});
});
