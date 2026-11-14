import { describe, expect, test } from "bun:test";
import { createDocumentNonces, isRelayAnnouncement } from "./document-nonces.ts";

const event = { anansi: "page-event", action: "bookmark" };
const ready = { anansi: "page-event", action: "ready", relay: true };

describe("createDocumentNonces", () => {
	test("a new document in the same tab keeps working after navigation", () => {
		const nonces = createDocumentNonces();
		nonces.remember({ tabId: 1, documentId: "first" }, "nonce-1");
		expect(nonces.expected({ tabId: 1, documentId: "second" }, event, "nonce-2")).toBe("nonce-2");
	});

	test("a document cannot change its nonce once known", () => {
		const nonces = createDocumentNonces();
		nonces.remember({ tabId: 1, documentId: "first" }, "nonce-1");
		expect(nonces.expected({ tabId: 1, documentId: "first" }, event, "forged")).toBe("nonce-1");
	});

	test("a page restored from history keeps its own nonce", () => {
		const nonces = createDocumentNonces();
		nonces.remember({ tabId: 1, documentId: "first" }, "nonce-1");
		nonces.remember({ tabId: 1, documentId: "second" }, "nonce-2");
		expect(nonces.expected({ tabId: 1, documentId: "first" }, event, "forged")).toBe("nonce-1");
	});

	test("without document ids, only a relay announcement replaces a tab nonce", () => {
		const nonces = createDocumentNonces();
		nonces.remember({ tabId: 1 }, "nonce-1");
		expect(nonces.expected({ tabId: 1 }, event, "nonce-2")).toBe("nonce-1");
		expect(nonces.expected({ tabId: 1 }, ready, "nonce-2")).toBe("nonce-2");
	});

	test("recognizes only the relay's own announcement", () => {
		expect(isRelayAnnouncement(ready)).toBe(true);
		expect(isRelayAnnouncement({ ...ready, relay: false })).toBe(false);
		expect(isRelayAnnouncement(event)).toBe(false);
		expect(isRelayAnnouncement(null)).toBe(false);
	});
});
