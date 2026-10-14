import { expect, test } from "bun:test";
import { xhrResponseJson, xhrResponseText } from "./xhr-response.ts";

test("JSON-mode native receipts do not touch the throwing responseText accessor", () => {
	const receipt = { data: { tweet_bookmark_put: "Done" } };
	const xhr = {
		responseType: "json" as const,
		response: receipt,
		get responseText(): string { throw new Error("InvalidStateError"); },
	};
	expect(xhrResponseText(xhr)).toBe(JSON.stringify(receipt));
	expect(xhrResponseJson(xhr)).toBe(receipt);
});

test("text-mode receipts are parsed and unsupported binary responses stay unrecognized", () => {
	expect(xhrResponseJson({ responseType: "text", response: null, responseText: '{"status_code":0}' })).toEqual({ status_code: 0 });
	expect(xhrResponseText({ responseType: "arraybuffer", response: new ArrayBuffer(1), get responseText(): string { throw new Error("InvalidStateError"); } })).toBeNull();
});
