import { describe, expect, test } from "bun:test";
import { createNativeTransitionOrder } from "./native-transition-order.ts";

describe("createNativeTransitionOrder", () => {
	const fakeTimers = () => {
		let nextId = 0;
		let now = 0;
		const timers = new Map<number, { at: number; callback: () => void }>();
		return {
			setTimeout: (callback: () => void, delayMs: number) => {
				const id = ++nextId;
				timers.set(id, { at: now + delayMs, callback });
				return id as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
				timers.delete(handle as unknown as number);
			},
			advance: (delayMs: number) => {
				now += delayMs;
				for (const [id, timer] of [...timers]) {
					if (timer.at > now) continue;
					timers.delete(id);
					timer.callback();
				}
			},
		};
	};

	test("confirms same-item transitions in request-start order", () => {
		const order = createNativeTransitionOrder();
		const first = order.reserve().bind("x:123")!;
		const second = order.reserve().bind("x:123")!;
		const events: string[] = [];

		expect(second.confirm(() => events.push("second"))).toBe(true);
		expect(events).toEqual([]);
		expect(first.confirm(() => events.push("first"))).toBe(true);
		expect(events).toEqual(["first", "second"]);
	});

	test("a failed earlier transition unblocks the next same-item event", () => {
		const order = createNativeTransitionOrder();
		const first = order.reserve().bind("github:alice/repo")!;
		const second = order.reserve().bind("github:alice/repo")!;
		const events: string[] = [];

		second.confirm(() => events.push("second"));
		expect(events).toEqual([]);
		first.fail();
		expect(events).toEqual(["second"]);
	});

	test("an earlier request for another item does not hold confirmed events", () => {
		const order = createNativeTransitionOrder();
		const first = order.reserve().bind("tiktok:video-a")!;
		const second = order.reserve().bind("tiktok:video-b")!;
		const events: string[] = [];

		second.confirm(() => events.push("video-b"));
		expect(events).toEqual(["video-b"]);
		first.confirm(() => events.push("video-a"));
		expect(events).toEqual(["video-b", "video-a"]);
	});

	test("an earlier unknown mutation identity is resolved before later callbacks run", () => {
		const order = createNativeTransitionOrder();
		const firstRequest = order.reserve();
		const second = order.reserve().bind("x:123")!;
		const events: string[] = [];

		second.confirm(() => events.push("second"));
		expect(events).toEqual([]);
		firstRequest.bind("x:123")!.confirm(() => events.push("first"));
		expect(events).toEqual(["first", "second"]);
	});

	test("identity timeout unblocks unrelated events and rejects late identity binding", async () => {
		const timers = fakeTimers();
		const order = createNativeTransitionOrder({
			identityTimeoutMs: 20,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const unknown = order.reserve();
		const otherItem = order.reserve().bind("x:456");
		const events: string[] = [];

		otherItem?.confirm(() => events.push("other-item"));
		expect(events).toEqual([]);
		timers.advance(20);
		await unknown.expired;
		expect(events).toEqual(["other-item"]);
		expect(unknown.bind("x:123")).toBeNull();
		expect(events).toEqual(["other-item"]);
	});

	test("confirmation timeout releases later same-item events and marks timeout", async () => {
		const timers = fakeTimers();
		const order = createNativeTransitionOrder({
			confirmationTimeoutMs: 30,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const first = order.reserve().bind("github:alice/repo");
		timers.advance(10);
		const second = order.reserve().bind("github:alice/repo");
		const events: string[] = [];
		second?.confirm(() => events.push("second"));

		timers.advance(20);
		await expect(first?.timedOut).resolves.toBe(true);
		expect(events).toEqual(["second"]);
		first?.confirm(() => events.push("late-first"));
		expect(events).toEqual(["second"]);
	});

	test("late confirmation reports that its callback was discarded", () => {
		const timers = fakeTimers();
		const order = createNativeTransitionOrder({
			confirmationTimeoutMs: 30,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const transition = order.reserve().bind("x:late")!;
		const events: string[] = [];

		timers.advance(30);
		expect(transition.confirm(() => events.push("stale bookmark"))).toBe(false);
		expect(events).toEqual([]);
	});
});
