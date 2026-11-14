import { describe, expect, test } from "bun:test";
import { requestSourceToggle } from "./source-toggle.ts";

const connection = { server: "https://library.test", token: "anansi_key" };

function transport(reply: () => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return reply();
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe("requestSourceToggle", () => {
	test("posts the switch with the stored key, no redirects, and a timeout", async () => {
		const t = transport(() => Response.json({ source: "tiktok", enabled: false }));
		expect(await requestSourceToggle(connection, "tiktok", false, t.fn)).toEqual({ ok: true, source: "tiktok", enabled: false });
		expect(t.calls).toHaveLength(1);
		const [call] = t.calls;
		expect(call!.url).toBe("https://library.test/api/extension/sources/tiktok");
		expect(call!.init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ enabled: false }) });
		expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer anansi_key");
		expect(call!.init.signal).toBeInstanceOf(AbortSignal);
	});

	test("a source that is always on is never sent", async () => {
		const t = transport(() => Response.json({}));
		expect(await requestSourceToggle(connection, "web", false, t.fn)).toMatchObject({ ok: false });
		expect(t.calls).toHaveLength(0);
	});

	test("failures are reported, never claimed as done", async () => {
		const cases: [() => Response | Promise<Response>, string][] = [
			[() => Promise.reject(new TypeError("offline")), "Could not reach the library"],
			[() => new Response(null, { status: 401 }), "Key rejected"],
			[() => new Response(null, { status: 500 }), "The library answered with HTTP 500"],
			[() => new Response("<html>proxy</html>", { status: 200 }), "Unexpected reply from the library"],
			// The server recorded something other than what was asked.
			[() => Response.json({ source: "tiktok", enabled: true }), "Unexpected reply from the library"],
			[() => Response.json({ source: "x", enabled: false }), "Unexpected reply from the library"],
		];
		for (const [reply, error] of cases) {
			expect(await requestSourceToggle(connection, "tiktok", false, transport(reply).fn)).toEqual({ ok: false, error });
		}
	});
});
