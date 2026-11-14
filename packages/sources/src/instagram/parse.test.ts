import { describe, expect, test } from "bun:test";
import {
	INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION,
	parseInstagramDomSnapshot,
	parseInstagramDomSnapshots,
	type InstagramDomSnapshot,
} from "./parse.ts";

// Synthetic Anansi DTO contract fixtures only. These do not describe or prove
// an authenticated Instagram DOM, request, response, or import flow.
const context = { importedAt: 1_788_390_000 };
const snapshot: InstagramDomSnapshot = {
	schemaVersion: INSTAGRAM_DOM_SNAPSHOT_SCHEMA_VERSION,
	shortcode: "AbC123_xyz",
	permalink: "https://instagram.com/p/AbC123_xyz/",
	caption: "  A synthetic caption  ",
	author: { handle: "Anansi.Example", name: " Anansi Example " },
	imageRefs: [
		"https://media.example.test/one.jpg",
		"https://media.example.test/two.jpg",
	],
};

describe("Instagram Anansi DOM snapshot DTO", () => {
	test("normalizes a synthetic image post without retaining a provider payload", () => {
		expect(parseInstagramDomSnapshot(snapshot, context)).toEqual({
			source: "instagram",
			externalId: "AbC123_xyz",
			url: "https://www.instagram.com/p/AbC123_xyz/",
			kind: "post",
			authorHandle: "anansi.example",
			authorName: "Anansi Example",
			body: "A synthetic caption",
			savedAt: context.importedAt,
			savedAtIsExact: false,
			metrics: {},
			media: [
				{ kind: "image", originUrl: "https://media.example.test/one.jpg" },
				{ kind: "image", originUrl: "https://media.example.test/two.jpg" },
			],
			links: [],
			raw: { snapshotSchemaVersion: 1 },
		});
	});

	test("normalizes a synthetic video poster and preserves carousel image order", () => {
		const mixed = parseInstagramDomSnapshot(
			{
				...snapshot,
				permalink: "https://www.instagram.com/reel/AbC123_xyz/",
				imageRefs: ["https://media.example.test/one.jpg"],
				videoPoster: "https://media.example.test/poster.jpg",
			},
			context,
		);
		expect(mixed).toMatchObject({
			kind: "video",
			media: [
				{ kind: "image", originUrl: "https://media.example.test/one.jpg" },
				{ kind: "video_poster", originUrl: "https://media.example.test/poster.jpg" },
			],
		});
	});

	test("rejects identity mismatch, unsupported hosts, and unsafe permalink forms", () => {
		for (const patch of [
			{ permalink: "https://www.instagram.com/p/OtherCode/" },
			{ permalink: "https://instagram.com.evil.test/p/AbC123_xyz/" },
			{ permalink: "http://www.instagram.com/p/AbC123_xyz/" },
			{ permalink: "https://user@www.instagram.com/p/AbC123_xyz/" },
			{ permalink: "https://www.instagram.com/p/AbC123_xyz/?token=secret" },
			{ shortcode: "not a shortcode" },
		]) {
			expect(parseInstagramDomSnapshot({ ...snapshot, ...patch }, context)).toBeNull();
		}
	});

	test("rejects malformed assets, empty content, and non-DTO credential fields", () => {
		for (const value of [
			{ ...snapshot, imageRefs: ["http://media.example.test/image.jpg"] },
			{ ...snapshot, imageRefs: ["https://user:pass@media.example.test/image.jpg"] },
			{ ...snapshot, imageRefs: ["https://media.example.test/image.jpg?sig=secret"] },
			{ ...snapshot, caption: "", imageRefs: [] },
			{ ...snapshot, cookie: "session-secret" },
			{ ...snapshot, author: { ...snapshot.author, accessToken: "secret" } },
		]) {
			expect(parseInstagramDomSnapshot(value, context)).toBeNull();
		}
	});

	test("rejects accessor-backed fields without executing them", () => {
		let reads = 0;
		const accessorSnapshot = { ...snapshot };
		Object.defineProperty(accessorSnapshot, "caption", {
			get() {
				reads++;
				return "synthetic caption";
			},
		});
		const accessorImages: string[] = [];
		Object.defineProperty(accessorImages, "0", {
			get() {
				reads++;
				return "https://media.example.test/image.jpg";
			},
			enumerable: true,
			configurable: true,
		});
		accessorImages.length = 1;

		expect(parseInstagramDomSnapshot(accessorSnapshot, context)).toBeNull();
		expect(
			parseInstagramDomSnapshot(
				{ ...snapshot, imageRefs: accessorImages },
				context,
			),
		).toBeNull();
		expect(reads).toBe(0);
	});

	test("deduplicates a batch by shortcode and skips invalid snapshots", () => {
		const items = parseInstagramDomSnapshots(
			[
				snapshot,
				{ ...snapshot, caption: "duplicate shortcode" },
				{ ...snapshot, shortcode: "bad id", permalink: "https://www.instagram.com/p/bad%20id/" },
			],
			context,
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.body).toBe("A synthetic caption");
	});

	test("rejects invalid batch shapes and invalid import timestamps", () => {
		expect(parseInstagramDomSnapshots({ snapshots: [snapshot] }, context)).toEqual([]);
		expect(parseInstagramDomSnapshot(snapshot, { importedAt: 0 })).toBeNull();
	});
});
