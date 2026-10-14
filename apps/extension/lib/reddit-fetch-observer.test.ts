import { expect, test } from "bun:test";
import { observeRedditFetch } from "./reddit-fetch-observer.ts";

const matches = (url: string) => /\/api\/(?:save|unsave)$/.test(url);

test("GraphQL receipt survives the page immediately consuming the original response", async () => {
	const receipt = { data: { updatePostSaveState: { ok: true, errors: null } } };
	const response = Response.json(receipt);
	const promise = Promise.resolve(response);
	let resolveNote!: (value: unknown) => void;
	const note = new Promise<unknown>((resolve) => { resolveNote = resolve; });
	const wrapped = observeRedditFetch(
		(() => promise) as unknown as typeof fetch,
		(url) => url.endsWith("/svc/shreddit/graphql"),
		(_url, _body, _ok, details) => resolveNote(details?.responseBody),
		{ needsResponseBody: () => true },
	);
	expect(wrapped("https://www.reddit.com/svc/shreddit/graphql", {
		method: "POST", body: JSON.stringify({ operation: "UpdatePostSaveState" }),
	})).toBe(promise);
	// The page owns this response and is free to consume it in its first continuation.
	expect(await (await promise).json()).toEqual(receipt);
	expect(await note).toEqual(receipt);
});

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
	let resolveNote!: () => void;
	const observed = new Promise<void>((resolve) => {
		resolveNote = resolve;
	});
	const native = ((_input, forwarded) => {
		expect(forwarded).toBe(init);
		return Promise.resolve(new Response(null));
	}) as typeof fetch;
	await observeRedditFetch(native, matches, (...args) => {
		notes.push(args);
		resolveNote();
	})(request, init);
	await observed;
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

test("snapshots a GraphQL Request before fetch and observes its successful receipt", async () => {
	const url = "https://www.reddit.com/svc/shreddit/graphql";
	const request = new Request(url, {
		method: "POST",
		body: JSON.stringify({
			operation: "UpdatePostSaveState",
			variables: { input: { postId: "t3_1uozn97", saveState: "SAVED" } },
		}),
	});
	const response = new Response(
		JSON.stringify({
			operation: "UpdatePostSaveState",
			data: { updatePostSaveState: { ok: true, errors: null } },
			errors: [],
		}),
		{ headers: { "content-type": "application/json" } },
	);
	const promise = Promise.resolve(response);
	const order: string[] = [];
	let resolveNote!: (details: unknown) => void;
	const observed = new Promise<unknown>((resolve) => {
		resolveNote = resolve;
	});
	const wrapped = observeRedditFetch(
		((input) => {
			order.push("fetch");
			expect(input).toBe(request);
			return promise;
		}) as typeof fetch,
		(candidate) => candidate === url,
		(_candidate, _body, ok, details) => {
			order.push("response");
			resolveNote({ ok, details });
		},
		{
			onRequestStart: (_candidate, body) => {
				order.push("request-start");
				return { body };
			},
			needsResponseBody: () => true,
		},
	);

	expect(wrapped(request)).toBe(promise);
	expect(order).toEqual(["request-start", "fetch"]);
	expect(await promise).toBe(response);
	const note = (await observed) as {
		ok: boolean;
		details: {
			request: { body: Promise<string | null> };
			responseBody: { data: { updatePostSaveState: { ok: boolean } } };
		};
	};
	expect(note.ok).toBe(true);
	expect(await note.details.request.body).toContain("t3_1uozn97");
	expect(note.details.responseBody.data.updatePostSaveState.ok).toBe(true);
	expect(order).toEqual(["request-start", "fetch", "response"]);
});

test("observes a cross-realm Request body used by Shreddit", async () => {
	const url = "https://www.reddit.com/svc/shreddit/graphql";
	const body = JSON.stringify({
		operation: "UpdatePostSaveState",
		variables: { input: { postId: "t3_1uozn97", saveState: "NONE" } },
		csrf_token: "redacted-test-value",
	});
	// A Request from another realm is a valid fetch input, but fails this
	// context's `instanceof Request` check. Its standard URL/method/clone shape
	// is enough for a safe best-effort observation.
	const requestLike = {
		url,
		method: "POST",
		clone: () => ({ text: async () => body }),
	};
	const promise = Promise.resolve(
		new Response(
			JSON.stringify({
				operation: "UpdatePostSaveState",
				data: { updatePostSaveState: { ok: true, errors: [] } },
				errors: [],
			}),
			{ headers: { "content-type": "application/json" } },
		),
	);
	let resolveNote!: (note: unknown) => void;
	const observed = new Promise<unknown>((resolve) => {
		resolveNote = resolve;
	});
	const wrapped = observeRedditFetch(
		((input: RequestInfo | URL) => {
			expect(input as unknown).toBe(requestLike);
			return promise;
		}) as unknown as typeof fetch,
		(candidate) => candidate === url,
		(candidate, requestBody, ok, details) => {
			resolveNote({ candidate, requestBody, ok, responseBody: details?.responseBody });
		},
		{
			onRequestStart: (_candidate, requestBody) => ({ requestBody }),
			needsResponseBody: () => true,
		},
	);

	expect(wrapped(requestLike as unknown as Request)).toBe(promise);
	const note = (await observed) as {
		candidate: string;
		requestBody: string;
		ok: boolean;
		responseBody: { data: { updatePostSaveState: { ok: boolean } } };
	};
	expect(note.candidate).toBe(url);
	expect(JSON.parse(note.requestBody)).toMatchObject({
		operation: "UpdatePostSaveState",
		variables: { input: { postId: "t3_1uozn97", saveState: "NONE" } },
	});
	expect(note.ok).toBe(true);
	expect(note.responseBody.data.updatePostSaveState.ok).toBe(true);
	expect(await promise).toBeInstanceOf(Response);
});

test("bounds request clone body observation and still returns the native promise", async () => {
	const url = "https://www.reddit.com/svc/shreddit/graphql";
	const request = new Request(url, { method: "POST", body: "ignored" });
	request.clone = (() => ({ text: () => new Promise<string>(() => {}) })) as typeof request.clone;
	const promise = Promise.resolve(new Response(null));
	let requestBody: Promise<unknown> | undefined;
	const wrapped = observeRedditFetch(
		(() => promise) as unknown as typeof fetch,
		() => true,
		() => {},
		{
			requestBodyTimeoutMs: 5,
			onRequestStart: (_url, body) => {
				requestBody = body;
				return undefined;
			},
		},
	);
	expect(wrapped(request)).toBe(promise);
	expect(await requestBody).toBeNull();
	expect(await promise).toBeInstanceOf(Response);
});

test("an unreadable GraphQL Request clone still exposes its accepted receipt", async () => {
	const url = "https://www.reddit.com/svc/shreddit/graphql";
	const request = new Request(url, { method: "POST", body: "unreadable" });
	request.clone = (() => ({ text: () => new Promise<string>(() => {}) })) as typeof request.clone;
	const response = new Response(
		JSON.stringify({
			operation: "UpdatePostSaveState",
			data: { updatePostSaveState: { ok: true, errors: null } },
			errors: [],
		}),
		{ headers: { "content-type": "application/json" } },
	);
	const promise = Promise.resolve(response);
	let initialBodyAvailable: boolean | undefined;
	let resolveNote!: (note: { body: unknown; ok: boolean; responseBody: unknown }) => void;
	const observed = new Promise<{ body: unknown; ok: boolean; responseBody: unknown }>((resolve) => {
		resolveNote = resolve;
	});
	const wrapped = observeRedditFetch(
		(() => promise) as unknown as typeof fetch,
		(candidate) => candidate === url,
		(_url, body, ok, details) => {
			resolveNote({ body, ok, responseBody: details?.responseBody });
		},
		{
			requestBodyTimeoutMs: 5,
			onRequestStart: (_url, _body, initialBody) => {
				initialBodyAvailable = initialBody.available;
				return undefined;
			},
			needsResponseBody: () => true,
		},
	);

	expect(wrapped(request)).toBe(promise);
	const note = await observed;
	expect(initialBodyAvailable).toBe(false);
	expect(note.body).toBeNull();
	expect(note.ok).toBe(true);
	expect(note.responseBody).toMatchObject({
		data: { updatePostSaveState: { ok: true } },
	});
	expect(await promise).toBe(response);
});

test("bounds a stalled GraphQL response clone without delaying fetch", async () => {
	const url = "https://www.reddit.com/svc/shreddit/graphql";
	const response = new Response("ok");
	response.clone = (() => ({ text: () => new Promise<string>(() => {}) })) as typeof response.clone;
	const promise = Promise.resolve(response);
	let resolveNote!: (body: unknown) => void;
	const observed = new Promise<unknown>((resolve) => {
		resolveNote = resolve;
	});
	const wrapped = observeRedditFetch(
		(() => promise) as unknown as typeof fetch,
		() => true,
		(_url, _body, ok, details) => {
			expect(ok).toBe(true);
			resolveNote(details?.responseBody);
		},
		{
			responseBodyTimeoutMs: 5,
			needsResponseBody: () => true,
		},
	);
	expect(wrapped(url, { method: "POST", body: "{}" })).toBe(promise);
	expect(await observed).toBeNull();
	expect(await promise).toBe(response);
});
