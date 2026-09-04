import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	extractGitHubStarsPage,
	githubRepositoryIdentity,
	readGitHubStarMutation,
	validatedGitHubRepositoryUrl,
	validatedGitHubStarsPageUrl,
} from "./github.ts";

const fixture = async (name: string): Promise<Document> => {
	const html = await Bun.file(
		`apps/extension/test/fixtures/github/${name}`,
	).text();
	return parseHTML(html).document as unknown as Document;
};

describe("GitHub URL validation", () => {
	test("normalizes repository identity while preserving the display URL", () => {
		expect(githubRepositoryIdentity("Vyom-26", "BMX_Racer")).toBe(
			"vyom-26/bmx_racer",
		);
		expect(
			validatedGitHubRepositoryUrl(
				"/Vyom-26/BMX_Racer",
				"https://github.com/stars",
			),
		).toEqual({
			owner: "Vyom-26",
			name: "BMX_Racer",
			fullName: "Vyom-26/BMX_Racer",
			identity: "vyom-26/bmx_racer",
			url: "https://github.com/Vyom-26/BMX_Racer",
		});
	});

	test("rejects profiles, nested routes, off-site links, credentials, and malformed names", () => {
		for (const value of [
			"/Vyom-26",
			"/Vyom-26/BMX_Racer/issues",
			"/Vyom-26/BMX_Racer/releases",
			"https://example.com/Vyom-26/BMX_Racer",
			"https://user:pass@github.com/Vyom-26/BMX_Racer",
			"/bad owner/repo",
		]) {
			expect(
				validatedGitHubRepositoryUrl(value, "https://github.com/stars"),
			).toBeNull();
		}
	});

	test("accepts only a bounded same-origin stars pagination URL", () => {
		expect(
			validatedGitHubStarsPageUrl(
				"/stars?after=opaque_cursor_2",
				"https://github.com/stars",
			),
		).toBe("https://github.com/stars?after=opaque_cursor_2");
		expect(
			validatedGitHubStarsPageUrl(
				"/stars/jojomensah89/repositories?filter=all&page=2",
				"https://github.com/stars",
			),
		).toBe(
			"https://github.com/stars/jojomensah89/repositories?filter=all&page=2",
		);
		for (const value of [
			"/stars/lists/work",
			"/stars/jojomensah89/repositories?filter=others",
			"/stars/jojomensah89/repositories?filter=all&language=typescript",
			"/settings/profile",
			"https://example.com/stars?page=2",
			"/stars?token=secret",
			"/stars#fragment",
		]) {
			expect(
				validatedGitHubStarsPageUrl(value, "https://github.com/stars"),
			).toBeNull();
		}
	});
});

describe("GitHub star mutations", () => {
	test("reads successful star and unstar repository actions", () => {
		expect(
			readGitHubStarMutation(
				"https://github.com/Vyom-26/BMX_Racer/star",
				"POST",
				true,
			),
		).toEqual({
			action: "save",
			externalId: "vyom-26/bmx_racer",
			canonicalUrl: "https://github.com/Vyom-26/BMX_Racer",
		});
		expect(
			readGitHubStarMutation(
				"https://github.com/Vyom-26/BMX_Racer/unstar",
				"DELETE",
				true,
			),
		).toMatchObject({ action: "unsave", externalId: "vyom-26/bmx_racer" });
	});

	test("ignores failed, read-only, nested, and off-origin requests", () => {
		for (const input of [
			["https://github.com/Vyom-26/BMX_Racer/star", "POST", false],
			["https://github.com/Vyom-26/BMX_Racer/star", "GET", true],
			["https://github.com/Vyom-26/BMX_Racer/issues/star", "POST", true],
			["https://example.com/Vyom-26/BMX_Racer/star", "POST", true],
		] as const) {
			expect(readGitHubStarMutation(input[0], input[1], input[2])).toBeNull();
		}
	});
});

describe("extractGitHubStarsPage", () => {
	test("extracts bounded public and private repository rows", async () => {
		const result = extractGitHubStarsPage(
			await fixture("stars-page.html"),
			"https://github.com/stars",
		);
		expect(result.kind).toBe("page");
		if (result.kind !== "page") return;
		expect(result.page).toEqual({
			schemaVersion: 1,
			pageType: "github_stars",
			repositories: [
				{
					identity: "vyom-26/bmx_racer",
					fullName: "Vyom-26/BMX_Racer",
					owner: "Vyom-26",
					name: "BMX_Racer",
					url: "https://github.com/Vyom-26/BMX_Racer",
					description: "A cel-shaded downhill BMX racing game.",
					language: "TypeScript",
					ownerAvatar: "https://avatars.githubusercontent.com/u/123?v=4",
					visibility: "public",
					stars: 58,
					forks: 17,
					starredAt: "2026-08-01T12:30:00Z",
				},
				{
					identity: "anansi-labs/private_archive",
					fullName: "Anansi-Labs/Private_Archive",
					owner: "Anansi-Labs",
					name: "Private_Archive",
					url: "https://github.com/Anansi-Labs/Private_Archive",
					description: "Internal research archive.",
					language: "Rust",
					ownerAvatar: "https://github.com/Anansi-Labs.png?size=80",
					visibility: "private",
					stars: 1234,
					forks: 20,
				},
			],
			nextUrl: "https://github.com/stars/Vyom-26/repositories?filter=all",
		});
	});

	test("continues from the full signed-in repository list", async () => {
		const result = extractGitHubStarsPage(
			await fixture("stars-page.html"),
			"https://github.com/stars/Vyom-26/repositories?filter=all",
		);
		expect(result.kind).toBe("page");
		if (result.kind !== "page") return;
		expect(result.page.repositories).toHaveLength(2);
		expect(result.page.nextUrl).toBe(
			"https://github.com/stars/Vyom-26/repositories?filter=all&page=2",
		);
	});

	test("does not copy page markup or sensitive form fields", async () => {
		const result = extractGitHubStarsPage(
			await fixture("stars-page.html"),
			"https://github.com/stars",
		);
		const encoded = JSON.stringify(result);
		expect(encoded).not.toContain("must-not-leak");
		expect(encoded).not.toContain("authenticity_token");
		expect(encoded).not.toContain("<script");
		expect(encoded).not.toContain("<form");
	});

	test("distinguishes signed-out, empty, and changed-shape pages", async () => {
		expect(
			extractGitHubStarsPage(
				await fixture("stars-signed-out.html"),
				"https://github.com/stars",
			),
		).toEqual({ kind: "signed_out" });
		expect(
			extractGitHubStarsPage(
				await fixture("stars-empty.html"),
				"https://github.com/stars",
			),
		).toEqual({
			kind: "empty",
			page: {
				schemaVersion: 1,
				pageType: "github_stars",
				repositories: [],
			},
		});
		expect(
			extractGitHubStarsPage(
				await fixture("stars-shape-changed.html"),
				"https://github.com/stars",
			),
		).toEqual({ kind: "page_shape_changed" });
	});
});
