import { describe, expect, test } from "bun:test";
import {
	connectionFromStatus,
	popupSourceRows,
	validatePopupRemoteConfig,
} from "./popup-connection.ts";

describe("popup connection truth", () => {
	test("all shipped providers remain visible before or without remote config", () => {
		for (const remote of [null, []]) {
			expect(popupSourceRows(remote).map((row) => row.source)).toEqual([
				"x",
				"reddit",
				"github",
				"tiktok",
			]);
		}
	});

	test("remote instructions augment rows and absent sources are marked off", () => {
		const rows = popupSourceRows([
			{
				source: "x",
				host: "x.com",
				mode: "page",
				operation: "Bookmarks",
			},
		]);

		expect(rows[0]).toMatchObject({
			source: "x",
			enabled: true,
			configured: true,
			operation: "Bookmarks",
		});
		expect(rows.slice(1).every((row) => !row.enabled && !row.configured)).toBe(
			true,
		);
	});

	test("offline rows remember which sources were on, and every platform row has a switch", () => {
		const lastKnown = [
			{ source: "x", host: "x.com", mode: "page" },
			{ source: "github", host: "github.com", mode: "page" },
		] as const;
		const rows = popupSourceRows(null, lastKnown);
		expect(rows.map((row) => [row.source, row.enabled])).toEqual([
			["x", true],
			["reddit", false],
			["github", true],
			["tiktok", false],
		]);
		expect(rows.every((row) => row.toggleable && !row.configured)).toBe(true);
		// Nothing known yet: the server's default, on.
		expect(popupSourceRows(null).every((row) => row.enabled)).toBe(true);
		// A live config always wins over the remembered one.
		expect(popupSourceRows([], lastKnown).every((row) => !row.enabled)).toBe(true);
	});

	test("authentication and compatibility errors are distinguishable", () => {
		expect(connectionFromStatus(401)).toMatchObject({ kind: "unauthorized" });
		expect(connectionFromStatus(403)).toMatchObject({ kind: "unauthorized" });
		expect(connectionFromStatus(404)).toMatchObject({ kind: "incompatible" });
		expect(connectionFromStatus(500)).toEqual({
			kind: "unreachable",
			message: "Server returned HTTP 500",
		});
	});

	test("rejects malformed, unknown, and duplicate source instructions", () => {
		const valid = { source: "x", host: "x.com", mode: "page" };
		const config = {
			version: 1,
			enabled: true,
			ingest: "https://anansi.example/api/ingest",
		};
		expect(validatePopupRemoteConfig({ ...config, sources: [valid] })).toBe(
			true,
		);
		for (const sources of [
			[null],
			[{ ...valid, source: "instagram" }],
			[{ ...valid, host: null }],
			[{ ...valid, mode: "worker" }],
			[{ ...valid, watchUrls: [null] }],
			[valid, valid],
		]) {
			expect(validatePopupRemoteConfig({ ...config, sources })).toBe(false);
		}
		expect(
			validatePopupRemoteConfig({ ...config, version: "1", sources: [valid] }),
		).toBe(false);
		expect(
			validatePopupRemoteConfig({ ...config, enabled: null, sources: [valid] }),
		).toBe(false);
		expect(
			validatePopupRemoteConfig({
				...config,
				ingest: "javascript:alert(1)",
				sources: [valid],
			}),
		).toBe(false);
	});
});
