import { describe, expect, test } from "bun:test";
import type { SyncStateRecord } from "./idb-outbox.ts";
import {
	runSessionImport,
	type SessionImportOptions,
	type SessionPage,
} from "./session-import.ts";
import { createSourceRuns, type SyncStateStore } from "./source-runs.ts";

const fixture = (name: string) =>
	Bun.file(`apps/extension/test/fixtures/github/${name}`).text();
const html = (text: string) =>
	new Response(text, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
const listing = (after: string | null = null, kind = "t3") =>
	Response.json({
		kind: "Listing",
		data: {
			children: [{ kind, data: { name: `${kind}_abc`, title: "Saved" } }],
			after,
		},
	});

function setup(source: "github" | "reddit", responses: Response[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const pages: SessionPage[] = [];
	const controller = new AbortController();
	const options: SessionImportOptions = {
		source,
		live: false,
		pageLimit: 40,
		signal: controller.signal,
		isCurrent: async () => true,
		onPage: async (page) => {
			pages.push(page);
		},
		fetcher: (async (input, init) => {
			requests.push({ url: String(input), init });
			const response = responses.shift();
			if (!response) throw new Error("Unexpected additional request");
			return response;
		}) as typeof fetch,
	};
	return { options, requests, pages, controller };
}

describe("imports without platform tabs", () => {
	test("GitHub follows the full list and pagination, preserving private rows without uploading HTML", async () => {
		const first = await fixture("stars-page.html");
		const end = first.replace(/<a rel="next"[^>]*>.*?<\/a>/s, "");
		const s = setup("github", [html(first), html(first), html(end)]);
		const result = await runSessionImport(s.options);
		expect(result).toEqual({ state: "complete", pages: 3, items: 6 });
		expect(s.requests.map((r) => r.url)).toEqual([
			"https://github.com/stars",
			"https://github.com/stars/Vyom-26/repositories?filter=all",
			"https://github.com/stars/Vyom-26/repositories?filter=all&page=2",
		]);
		expect(JSON.stringify(s.pages)).toContain('"visibility":"private"');
		expect(JSON.stringify(s.pages)).not.toContain("must-not-leak");
		expect(JSON.stringify(s.pages)).not.toContain("authenticity_token");
		for (const { init } of s.requests) {
			expect(init).toMatchObject({
				credentials: "include",
				redirect: "manual",
				method: "GET",
			});
			expect(new Headers(init?.headers).has("cookie")).toBe(false);
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
		}
	});

	test("Reddit resolves the signed-in username and imports posts and comments", async () => {
		const s = setup("reddit", [
			Response.json({ data: { name: "my-user" } }),
			listing("t3_next"),
			listing(null, "t1"),
		]);
		expect(await runSessionImport(s.options)).toEqual({
			state: "complete",
			pages: 2,
			items: 2,
		});
		expect(s.requests.map((r) => r.url)).toEqual([
			"https://www.reddit.com/api/me.json",
			"https://www.reddit.com/user/my-user/saved.json?limit=100&raw_json=1",
			"https://www.reddit.com/user/my-user/saved.json?limit=100&raw_json=1&after=t3_next",
		]);
		expect(JSON.stringify(s.pages)).toContain('"kind":"t1"');
	});

	test("the next request waits for durable page acceptance", async () => {
		const s = setup("reddit", [
			Response.json({ data: { name: "my-user" } }),
			listing("t3_next"),
			listing(),
		]);
		let persisted = false;
		const fetcher = s.options.fetcher;
		if (!fetcher) throw new Error("Missing test fetcher");
		s.options.fetcher = (async (url, init) => {
			if (String(url).includes("after=")) expect(persisted).toBe(true);
			return fetcher(url, init);
		}) as typeof fetch;
		s.options.onPage = async () => {
			await Promise.resolve();
			persisted = true;
		};
		await runSessionImport(s.options);
	});

	test("a failed enqueue never advances to another page", async () => {
		const s = setup("github", [html(await fixture("stars-page.html"))]);
		s.options.onPage = async () => {
			throw new Error("outbox full");
		};
		await expect(runSessionImport(s.options)).rejects.toThrow("outbox full");
		expect(s.requests).toHaveLength(1);
	});

	test("a bounded import resumes from the durable cursor after a worker restart", async () => {
		const records = new Map<string, SyncStateRecord>();
		const store: SyncStateStore = {
			getSyncState: async (source) =>
				structuredClone(records.get(source) ?? null),
			putSyncState: async (value) => {
				records.set(value.source, structuredClone(value));
			},
			deleteSyncState: async (source) => {
				records.delete(source);
			},
		};
		const runs = createSourceRuns({
			store,
			now: () => 10_000,
			createId: () => "first",
		});
		await runs.begin("reddit");
		const first = setup("reddit", [
			Response.json({ data: { name: "me" } }),
			listing("t3_next"),
		]);
		first.options.pageLimit = 1;
		first.options.onPage = async (page, number) => {
			await runs.capturePage("reddit", number);
			await runs.setCursor("reddit", page.cursor);
		};
		expect((await runSessionImport(first.options)).state).toBe("limited");
		await runs.stop("reddit");
		const revived = createSourceRuns({
			store,
			now: () => 20_000,
			createId: () => "second",
		});
		const { run } = await revived.begin("reddit");
		const second = setup("reddit", [
			Response.json({ data: { name: "me" } }),
			listing(),
		]);
		second.options.cursor = run.cursor;
		second.options.onPage = async (page) =>
			revived.setCursor("reddit", page.cursor);
		expect((await runSessionImport(second.options)).state).toBe("complete");
		expect(second.requests[1]?.url).toContain("after=t3_next");
		expect((await revived.current("reddit")).cursor).toBeUndefined();
	});

	test("pause during fetch discards the response and fetches no further pages", async () => {
		const s = setup("github", [html(await fixture("stars-page.html"))]);
		const fetcher = s.options.fetcher;
		if (!fetcher) throw new Error("Missing test fetcher");
		s.options.fetcher = (async (url, init) => {
			const response = await fetcher(url, init);
			s.options.isCurrent = async () => false;
			return response;
		}) as typeof fetch;
		expect((await runSessionImport(s.options)).state).toBe("cancelled");
		expect(s.pages).toHaveLength(0);
		expect(s.requests).toHaveLength(1);
	});

	test("already aborted imports make no requests", async () => {
		const s = setup("reddit", []);
		s.controller.abort();
		expect((await runSessionImport(s.options)).state).toBe("cancelled");
		expect(s.requests).toHaveLength(0);
	});

	test("live refresh starts at the top and stops after one page", async () => {
		const s = setup("reddit", [
			Response.json({ data: { name: "me" } }),
			listing("t3_next"),
		]);
		s.options.live = true;
		s.options.cursor = "t3_old";
		expect((await runSessionImport(s.options)).state).toBe("complete");
		expect(s.requests[1]?.url).toContain("limit=20");
		expect(s.requests[1]?.url).not.toContain("after=");
	});

	test("an empty GitHub library finishes successfully", async () => {
		const s = setup("github", [html(await fixture("stars-empty.html"))]);
		expect(await runSessionImport(s.options)).toEqual({
			state: "complete",
			pages: 1,
			items: 0,
		});
	});

	test("signed-out HTML is distinguished from an empty library", async () => {
		const s = setup("github", [html(await fixture("stars-signed-out.html"))]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "not_signed_in",
		});
		expect(s.pages).toHaveLength(0);
	});

	test("Reddit identity response is not uploaded and a missing session asks for sign-in", async () => {
		const s = setup("reddit", [Response.json({ data: {} })]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "not_signed_in",
		});
		expect(s.pages).toHaveLength(0);
	});

	test.each([301, 302, 401])(
		"session response %i ends without following redirects",
		async (status) => {
			const s = setup("github", [
				new Response(null, {
					status,
					headers: { location: "https://example.com/login" },
				}),
			]);
			await expect(runSessionImport(s.options)).rejects.toMatchObject({
				code: "not_signed_in",
			});
			expect(s.requests).toHaveLength(1);
		},
	);

	test.each([429, 503])(
		"rate limiting %i preserves the last accepted page",
		async (status) => {
			const s = setup("reddit", [
				Response.json({ data: { name: "me" } }),
				listing("t3_next"),
				new Response(null, { status }),
			]);
			await expect(runSessionImport(s.options)).rejects.toMatchObject({
				code: "rate_limited",
			});
			expect(s.pages).toHaveLength(1);
			expect(s.pages[0]?.cursor).toBe("t3_next");
		},
	);

	test("rate limiting carries a bounded Retry-After delay to the durable scheduler", async () => {
		const s = setup("github", [
			new Response(null, { status: 429, headers: { "retry-after": "120" } }),
		]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "rate_limited",
			retryAfterMs: 120_000,
		});
	});

	test("malformed Reddit listings fail rather than claiming an empty import", async () => {
		const s = setup("reddit", [
			Response.json({ data: { name: "me" } }),
			Response.json({ data: { children: [] } }),
		]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "page_shape_changed",
		});
		expect(s.pages).toHaveLength(0);
	});

	test("repeated pagination fails before committing a looping cursor", async () => {
		const s = setup("reddit", [
			Response.json({ data: { name: "me" } }),
			listing("t3_next"),
			listing("t3_next"),
		]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "page_shape_changed",
		});
		expect(s.pages).toHaveLength(1);
	});

	test("GitHub cursor cannot redirect credentialed fetches off-site", async () => {
		const s = setup("github", []);
		s.options.cursor = "https://example.com/stars";
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "page_shape_changed",
		});
		expect(s.requests).toHaveLength(0);
	});

	test("HTML sign-in/challenge responses do not become Reddit data", async () => {
		const s = setup("reddit", [html("<html>Sign in</html>")]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "page_shape_changed",
		});
		expect(s.pages).toHaveLength(0);
	});

	test("oversized HTML is rejected before parsing", async () => {
		const response = html("<html></html>");
		response.headers.set("content-length", String(9 * 1024 * 1024));
		const s = setup("github", [response]);
		await expect(runSessionImport(s.options)).rejects.toMatchObject({
			code: "page_shape_changed",
		});
	});
});
