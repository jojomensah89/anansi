import { expect, test } from "bun:test";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import {
	getSyncSettings,
	knownSyncIds,
	pendingPlatformSync,
	requestPlatformSync,
	setSyncSettings,
	type AnansiDb,
} from "@anansi/db";
import { checkPublicGithub } from "./public-github-sync.ts";
function database() {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	return local as unknown as AnansiDb;
}
function repo(name: string) {
	return {
		starred_at: "2026-11-01T00:00:00Z",
		repo: {
			full_name: `owner/${name}`,
			html_url: `https://github.com/owner/${name}`,
			description: "saved",
			owner: { login: "owner" },
		},
	};
}
test("agents request only Reddit and GitHub by default and throttle per platform for fifteen minutes", async () => {
	const db = database();
	expect(await requestPlatformSync(db, 1000, "agent")).toEqual([
		"reddit",
		"github",
	]);
	expect(await requestPlatformSync(db, 1001, "agent")).toEqual([]);
	expect(await requestPlatformSync(db, 1900, "agent")).toEqual([
		"reddit",
		"github",
	]);
	await setSyncSettings(db, { agentTabs: true, githubUsername: null });
	expect(await requestPlatformSync(db, 1901, "agent")).toEqual(["x", "tiktok"]);
	await setSyncSettings(db, { agentTabs: false, githubUsername: null });
	expect((await pendingPlatformSync(db)).map((row) => row.source)).toEqual([
		"reddit",
		"github",
	]);
});
test("public Github needs an explicit owner username, never credentials, and uses its skip window", async () => {
	const db = database();
	let calls = 0;
	const stub = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		calls++;
		expect(String(input)).toContain("api.github.com/users/owner/starred");
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		expect(init?.credentials).toBe("omit");
		expect(init?.redirect).toBe("error");
		return Response.json([repo("new")]);
	}) as unknown as typeof fetch;
	await checkPublicGithub(db, stub, 1000);
	expect(calls).toBe(0);
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	await checkPublicGithub(db, stub, 1000);
	expect(calls).toBe(1);
	expect(await knownSyncIds(db, "github")).toEqual(["owner/new"]);
	await checkPublicGithub(db, stub, 1001);
	expect(calls).toBe(1);
});
test("public Github stops on a known item instead of following another page", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	const stub = (async () =>
		Response.json([repo("known")])) as unknown as typeof fetch;
	await checkPublicGithub(db, stub, 1000);
	let calls = 0;
	await checkPublicGithub(
		db,
		(async () => {
			calls++;
			return Response.json(Array.from({ length: 100 }, () => repo("known")));
		}) as unknown as typeof fetch,
		1400,
	);
	expect(calls).toBe(1);
});
test("public rate limits and failures become status, without throwing", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	await checkPublicGithub(
		db,
		(async () =>
			new Response("", {
				status: 429,
				headers: { "x-ratelimit-reset": "4000" },
			})) as unknown as typeof fetch,
		1000,
	);
	expect((await getSyncSettings(db)).githubError).toBe("rate_limited");
	let calls = 0;
	await checkPublicGithub(
		db,
		(async () => {
			calls++;
			throw new Error("offline");
		}) as unknown as typeof fetch,
		1001,
	);
	expect(calls).toBe(0);
	await checkPublicGithub(
		db,
		(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch,
		4001,
	);
	expect((await getSyncSettings(db)).githubError).toBe("public_github_failed");
});
test("username validation rejects URLs and request injection", async () => {
	const db = database();
	for (const githubUsername of ["https://evil.test", "../users", "owner?x=1"])
		await expect(
			setSyncSettings(db, { agentTabs: false, githubUsername }),
		).rejects.toThrow();
});

test("forced public checks bypass successful skip windows but respect rate-limit backoff", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	let calls = 0;
	const ok = (async () => {
		calls++;
		return Response.json([]);
	}) as unknown as typeof fetch;
	await checkPublicGithub(db, ok, 1000);
	await checkPublicGithub(db, ok, 1001, true);
	expect(calls).toBe(2);
	await checkPublicGithub(
		db,
		(async () => new Response("", { status: 429 })) as unknown as typeof fetch,
		1400,
	);
	await checkPublicGithub(db, ok, 1401, true);
	expect(calls).toBe(2);
});

test("known IDs are authenticated, source-scoped and exclude unsaved rows", async () => {
	const { handleApi } = await import("./api.ts");
	const { items } = await import("@anansi/db");
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	await checkPublicGithub(
		db,
		(async () => Response.json([repo("one")])) as unknown as typeof fetch,
		1000,
	);
	const environment = {
		db,
		ingestToken: "capture",
		libraryToken: "owner-secret",
	};
	expect(
		(
			await handleApi(
				environment,
				new Request(
					"https://library.test/api/extension/known-ids?source=github",
				),
			)
		).status,
	).toBe(401);
	const request = (source: string) =>
		new Request(
			`https://library.test/api/extension/known-ids?source=${source}`,
			{ headers: { authorization: "Bearer capture" } },
		);
	expect((await handleApi(environment, request("invalid"))).status).toBe(400);
	expect(
		(await (await handleApi(environment, request("github"))).json()) as unknown,
	).toEqual({ ids: ["owner/one"] });
	await db.update(items).set({ platformSaved: 0 });
	expect(
		(await (await handleApi(environment, request("github"))).json()) as unknown,
	).toEqual({ ids: [] });
});
test("HTTP MCP searches return immediately with scoped requests and offline freshness", async () => {
	const { handleMcp } = await import("./mcp.ts");
	const db = database();
	const request = (token: string) =>
		new Request("https://library.test/mcp", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "search_saved", arguments: { query: "saved" } },
			}),
		});
	expect(
		(await handleMcp({ db, token: "agent" }, request("wrong"))).status,
	).toBe(401);
	expect(await pendingPlatformSync(db)).toEqual([]);
	const response = await handleMcp({ db, token: "agent" }, request("agent"));
	const text = await response.text();
	expect(response.status).toBe(200);
	const wire = JSON.parse(
		text.startsWith("event:") ? text.split("data: ")[1]!.trim() : text,
	);
	const result = JSON.parse(wire.result.content[0].text);
	expect(result.freshness.browserOffline).toBe(true);
	expect(result.freshness.platforms.reddit.requested).toBe(true);
	expect(result.freshness.platforms.x.requested).toBe(false);
	const again = await handleMcp({ db, token: "agent" }, request("agent"));
	const againText = await again.text();
	const second = JSON.parse(
		againText.startsWith("event:")
			? againText.split("data: ")[1]!.trim()
			: againText,
	);
	expect(
		JSON.parse(second.result.content[0].text).freshness.platforms.reddit
			.requested,
	).toBe(false);
});

test("overlapping library visits share one public GitHub lease", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	let calls = 0;
	const stub = (async () => {
		calls++;
		await Promise.resolve();
		return Response.json([]);
	}) as unknown as typeof fetch;
	await Promise.all([
		checkPublicGithub(db, stub, 1000),
		checkPublicGithub(db, stub, 1000),
	]);
	expect(calls).toBe(1);
});
test("ordinary library requests remain eligible after an agent disables tab checks", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: true, githubUsername: null });
	await requestPlatformSync(db, 1000, "agent");
	await setSyncSettings(db, { agentTabs: false, githubUsername: null });
	await requestPlatformSync(db, 1000, "library");
	expect((await pendingPlatformSync(db)).map((row) => row.source)).toEqual([
		"x",
		"reddit",
		"github",
		"tiktok",
	]);
});
test("malformed public responses fail visibly instead of reporting a successful empty library", async () => {
	const db = database();
	await setSyncSettings(db, { agentTabs: false, githubUsername: "owner" });
	await checkPublicGithub(
		db,
		(async () =>
			Response.json({ unexpected: true })) as unknown as typeof fetch,
		1000,
	);
	expect((await getSyncSettings(db)).githubError).toBe("public_github_failed");
	expect(await knownSyncIds(db, "github")).toEqual([]);
});
