import { describe, expect, test } from "bun:test";
import type { ItemEventCapture, RawPageCapture } from "@anansi/sources";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { handleApi } from "./api.ts";

const NOW = 1_788_390_000;

function repository(
	owner: string,
	name: string,
	patch: Record<string, unknown> = {},
) {
	return {
		identity: `${owner.toLowerCase()}/${name.toLowerCase()}`,
		fullName: `${owner}/${name}`,
		owner,
		name,
		url: `https://github.com/${owner}/${name}`,
		description: `Searchable ${name} repository`,
		language: "TypeScript",
		visibility: "public",
		stars: 12,
		forks: 3,
		starredAt: "2026-09-04T10:00:00Z",
		...patch,
	};
}

describe("GitHub extension capture flow", () => {
	test("imports, captures live provenance, retains an unstar, and restores a re-star", async () => {
		const local = openLocalDb(":memory:");
		migrateLocalDb(local);
		const env = { db: local as unknown as AnansiDb, ingestToken: "test-token", libraryToken: "library-token" };
		const request = (path: string, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			if (!headers.has("authorization")) headers.set("authorization", "Bearer library-token");
			return handleApi(env, new Request(`https://anansi.test${path}`, { ...init, headers }));
		};
		const json = async (response: Response | Promise<Response>) =>
			(await (await response).json()) as any;
		const ingest = (capture: RawPageCapture | ItemEventCapture) =>
			request("/api/ingest", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
					"idempotency-key": capture.eventId,
				},
				body: JSON.stringify(capture),
			});

		const imported: RawPageCapture = {
			schemaVersion: 1,
			payloadType: "raw_page",
			eventId: "github-import:page:1",
			source: "github",
			action: "snapshot",
			observedAt: NOW,
			captureMethod: "platform_import",
			runId: "github-import",
			page: 1,
			raw: {
				schemaVersion: 1,
				pageType: "github_stars",
				repositories: [
					repository("Example-Org", "Private-Notes", {
						visibility: "private",
					}),
				],
			},
		};
		expect((await ingest(imported)).status).toBe(200);

		const livePage: RawPageCapture = {
			...imported,
			eventId: "github-live:page:1",
			captureMethod: "platform_event",
			runId: "github-live",
			observedAt: NOW + 10,
			raw: {
				schemaVersion: 1,
				pageType: "github_stars",
				repositories: [repository("Vyom-26", "BMX_Racer")],
			},
		};
		expect((await ingest(livePage)).status).toBe(200);

		const event = (
			action: "save" | "unsave",
			observedAt: number,
		): ItemEventCapture => ({
			schemaVersion: 1,
			payloadType: "item_event",
			eventId: `github:${action}:vyom-26/bmx_racer:${observedAt}`,
			source: "github",
			action,
			externalId: "vyom-26/bmx_racer",
			canonicalUrl: "https://github.com/Vyom-26/BMX_Racer",
			observedAt,
			captureMethod: "platform_event",
		});

		expect((await ingest(event("save", NOW + 11))).status).toBe(200);
		expect((await ingest(event("unsave", NOW + 12))).status).toBe(200);
		const removed = await json(
			request("/api/items?source=github&removed=only&limit=10"),
		);
		expect(removed.items.map((item: { title: string }) => item.title)).toEqual([
			"Vyom-26/BMX_Racer",
		]);
		expect(removed.items[0].platformSaved).toBe(0);

		expect((await ingest(event("save", NOW + 13))).status).toBe(200);
		const restored = await json(
			request("/api/items?source=github&removed=exclude&limit=10"),
		);
		expect(restored.items).toHaveLength(2);
		expect(restored.items.find((item: { title: string }) => item.title === "Vyom-26/BMX_Racer"))
			.toMatchObject({ platformSaved: 1, visibility: "public" });
		expect(restored.items.find((item: { visibility: string }) => item.visibility === "private"))
			.toBeDefined();

		const search = await json(request("/api/search?q=Searchable+BMX_Racer&source=github"));
		expect(search.results).toHaveLength(1);
		expect(search.results[0].title).toBe("Vyom-26/BMX_Racer");

		const heartbeat = await request("/api/extension/heartbeat", {
			method: "POST",
			headers: {
				authorization: "Bearer test-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				schemaVersion: 1,
				installationId: "123e4567-e89b-42d3-a456-426614174000",
				extensionVersion: "0.1.0",
				queue: { queued: 1, uploading: 0, retrying: 0, failed: 0 },
				sources: {
					github: {
						phase: "running",
						queued: 1,
						uploading: 0,
						retrying: 0,
						failed: 0,
					},
				},
			}),
		});
		expect(heartbeat.status).toBe(200);

		const sources = await json(request("/api/sources"));
		expect(sources.sources.find((source: { source: string }) => source.source === "github"))
			.toMatchObject({
				support: "supported",
				toggleable: true,
				items: 2,
				imported: 1,
				live: 1,
				runtime: { phase: "running", queued: 1 },
			});
	});
});
