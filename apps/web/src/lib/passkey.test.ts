import { describe, expect, test } from "bun:test";
import { passkeyError, passkeyMeta, relativeDay } from "./passkey.ts";

const named = (name: string) => Object.assign(new Error("x"), { name });

describe("passkeyError", () => {
	test("stays quiet when the person closes the browser prompt", () => {
		expect(passkeyError(named("NotAllowedError"))).toBeNull();
		expect(passkeyError(named("AbortError"))).toBeNull();
	});

	test("maps server replies to plain words", () => {
		expect(passkeyError(new Error("unauthorized"))).toBe("That secret didn’t work");
		expect(passkeyError(new Error("passkey limit"))).toBe("You already have 10 passkeys");
		expect(passkeyError(new Error("last passkey"))).toBe("Add another passkey before removing this one");
		expect(passkeyError(new Error("invalid or expired challenge"))).toBe("That took too long. Try again");
		expect(passkeyError(new Error("verification failed"))).toBe("That passkey wasn’t accepted. Try again");
		expect(passkeyError(new Error("too many requests; retry shortly"))).toBe("Too many tries. Wait a minute");
	});

	test("an authenticator that already holds a passkey says so", () => {
		expect(passkeyError(named("InvalidStateError"))).toBe("This device already has a passkey here");
	});

	test("anything else is shown capitalised", () => {
		expect(passkeyError(new Error("request too large"))).toBe("Request too large");
		expect(passkeyError("boom")).toBe("Something went wrong. Try again");
	});
});

describe("relativeDay", () => {
	const now = new Date(2026, 10, 12, 15, 0).getTime();
	const at = (y: number, m: number, d: number) => new Date(y, m, d, 9, 30).getTime();

	test("near dates read relative", () => {
		expect(relativeDay(at(2026, 10, 12), now)).toBe("today");
		expect(relativeDay(at(2026, 10, 11), now)).toBe("yesterday");
		expect(relativeDay(at(2026, 10, 3), now)).toBe("9 days ago");
	});

	test("older dates are printed, with the year only when it differs", () => {
		expect(relativeDay(at(2026, 6, 15), now)).toBe("15 Jul");
		expect(relativeDay(at(2025, 0, 2), now)).toBe("2 Jan 2025");
	});

	test("a clock running ahead never reads as the future", () => {
		expect(relativeDay(now + 60_000, now)).toBe("today");
	});
});

test("passkeyMeta names when it was added and last used", () => {
	const now = new Date(2026, 10, 12, 15, 0).getTime();
	expect(passkeyMeta({ createdAt: new Date(2026, 6, 15).getTime(), lastUsedAt: now }, now)).toBe("Added 15 Jul · Used today");
	expect(passkeyMeta({ createdAt: now, lastUsedAt: null }, now)).toBe("Added today · Not used yet");
});
