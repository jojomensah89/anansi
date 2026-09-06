import { expect, test } from "bun:test";
import { observeRedditFetch } from "./reddit-fetch-observer.ts";

const matches = (url: string) => /\/api\/(?:save|unsave)$/.test(url);

test.each(["omit", "same-origin", "include"] as const)(
	"Reddit preload request keeps %s credentials and its original promise",
	async (credentials) => {
		const request = new Request(
			"https://www.reddit.com/svc/events/preload-head?renderId=fixture&pageType=community",
			{ credentials },
		);
		const init = { mode: "cors" as const, credentials };
		// Bun 1.3 reports Request.credentials as "include" for all modes.
		// Check that the Request is unchanged and the explicit init is exact.
		const originalCredentials = request.credentials;
		const response = new Response("preload response");
		const promise = Promise.resolve(response);
		let calls = 0;
		let observations = 0;
		const native = ((input, forwarded) => {
			calls++;
			expect(input).toBe(request);
			expect(forwarded).toBe(init);
			expect(request.credentials).toBe(originalCredentials);
			expect(forwarded?.credentials).toBe(credentials);
			return promise;
		}) as typeof fetch;
		const wrapped = observeRedditFetch(native, matches, () => {
			observations++;
		});
		expect(wrapped(request, init)).toBe(promise);
		expect(await promise).toBe(response);
		expect(calls).toBe(1);
		expect(observations).toBe(0);
	},
);

test("Request-based save is captured even when native fetch consumes its body", async () => {
	const request = new Request("https://www.reddit.com/api/save", {
		method: "POST",
		body: "id=t3_saved",
	});
	const notes: unknown[][] = [];
	let resolveNote!: () => void;
	const observed = new Promise<void>((resolve) => {
		resolveNote = resolve;
	});
	const native = (async (input) => {
		expect(input).toBe(request);
		expect(await request.text()).toBe("id=t3_saved");
		return new Response(null, { status: 200 });
	}) as typeof fetch;
	const wrapped = observeRedditFetch(native, matches, (...args) => {
		notes.push(args);
		resolveNote();
	});
	await wrapped(request);
	await observed;
	expect(notes).toEqual([[request.url, "id=t3_saved", true]]);
});

test("init body overrides the Request body without mutating either", async () => {
	const request = new Request("https://www.reddit.com/api/unsave", {
		method: "POST",
		body: "id=t3_old",
	});
	const init = { body: "id=t3_new", credentials: "include" as const };
	const notes: unknown[][] = [];
	const native = ((_input, forwarded) => {
		expect(forwarded).toBe(init);
		return Promise.resolve(new Response(null));
	}) as typeof fetch;
	await observeRedditFetch(native, matches, (...args) => {
		notes.push(args);
	})(request, init);
	await Promise.resolve();
	expect(notes).toEqual([[request.url, "id=t3_new", true]]);
	expect(await request.text()).toBe("id=t3_old");
});

test("observer failure does not replace the successful response", async () => {
	const response = new Response(null);
	const promise = Promise.resolve(response);
	const native = (() => promise) as unknown as typeof fetch;
	const wrapped = observeRedditFetch(native, matches, () => {
		throw new Error("observer failed");
	});
	expect(
		wrapped("https://www.reddit.com/api/save", {
			method: "POST",
			body: "id=t3_saved",
		}),
	).toBe(promise);
	expect(await promise).toBe(response);
	await Promise.resolve();
});

test("failed saves and network failures never emit saved events", async () => {
	let notes = 0;
	const failed = Promise.resolve(new Response(null, { status: 403 }));
	const wrapped = observeRedditFetch(
		(() => failed) as unknown as typeof fetch,
		matches,
		() => {
			notes++;
		},
	);
	await wrapped("https://www.reddit.com/api/save", { method: "POST" });
	const network = Promise.reject(new Error("offline"));
	const offline = observeRedditFetch(
		(() => network) as unknown as typeof fetch,
		matches,
		() => {
			notes++;
		},
	);
	expect(offline("https://www.reddit.com/api/save", { method: "POST" })).toBe(
		network,
	);
	await expect(network).rejects.toThrow("offline");
	expect(notes).toBe(0);
});
