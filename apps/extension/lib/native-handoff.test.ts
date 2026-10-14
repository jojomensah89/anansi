import { describe, expect, test } from "bun:test";
import {
	nativeHandoffStorageKey,
	parseNativeHandoffStoreRequest,
} from "./native-handoff.ts";

const bookmark = {
	anansi: "page-event",
	messageVersion: 1,
	source: "x",
	nonce: "0123456789abcdef0123456789abcdef",
	action: "bookmark",
	bookmarkAction: "save",
	externalId: "tweet-1",
	mutationId: "mutation-1",
};

describe("native handoff bridge message", () => {
	test("accepts only a bounded store envelope", () => {
		expect(parseNativeHandoffStoreRequest({
			anansi: "native-handoff",
			action: "store",
			messageVersion: 1,
			message: bookmark,
		})).toMatchObject({ action: "store", message: bookmark });
		expect(parseNativeHandoffStoreRequest({
			anansi: "native-handoff",
			action: "store",
			messageVersion: 1,
			message: bookmark,
			key: "arbitrary-storage-key",
		})).toBeNull();
		expect(parseNativeHandoffStoreRequest({
			anansi: "native-handoff",
			action: "store",
			messageVersion: 2,
			message: bookmark,
		})).toBeNull();
		expect(parseNativeHandoffStoreRequest({
			anansi: "native-handoff",
			action: "store",
			messageVersion: 1,
			message: { ...bookmark, raw: "x".repeat(1_100_000) },
		})).toBeNull();
	});

	test("derives a fixed-prefix key from a validated source and mutation id", () => {
		expect(nativeHandoffStorageKey("x", "mutation-1")).toBe("native-handoff:x:mutation-1");
		expect(nativeHandoffStorageKey("reddit", "bad/key")).toBeNull();
	});
});
