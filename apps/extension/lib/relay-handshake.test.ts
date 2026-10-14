import { expect, test } from "bun:test";
import { createRelayHandshake } from "./relay-handshake.ts";

test("configuration sent before the page listener starts is replayed at document readiness", () => {
	let listening = false;
	const received: object[] = [];
	const handshake = createRelayHandshake<object>((message) => {
		if (listening) received.push(message);
	});
	const message = { action: "configure", nonce: "same-correlation-value" };
	handshake.configure(message);
	listening = true;
	handshake.documentReady();
	expect(received).toEqual([message]);
});

test("readiness before configuration is harmless and only the latest configuration is replayed", () => {
	const received: string[] = [];
	const handshake = createRelayHandshake<string>((message) => received.push(message));
	handshake.documentReady();
	handshake.configure("old");
	handshake.configure("current");
	handshake.documentReady();
	expect(received).toEqual(["old", "current", "current"]);
});
