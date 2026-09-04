import { describe, expect, test } from "bun:test";
import type { ExtensionHealth, SourceRow } from "./api.ts";
import { extensionLabel, sourcePresentation } from "./source-state.ts";

const extension = (
	connection: ExtensionHealth["connection"] = "connected",
): ExtensionHealth => ({
	connection,
	extensionVersion: connection === "never_connected" ? null : "0.1.0",
	lastSeenAt: connection === "never_connected" ? null : 1_000,
	activeClients: connection === "connected" ? 1 : 0,
	queue: { queued: 0, uploading: 0, retrying: 0, failed: 0 },
	sources: {},
});

const row = (patch: Partial<SourceRow> = {}): SourceRow => ({
	source: "x",
	name: "X bookmarks",
	host: "x.com",
	note: "Bookmarks",
	support: "supported",
	mode: "page",
	toggleable: true,
	requiresExtension: true,
	enabled: true,
	items: 0,
	live: 0,
	imported: 0,
	toolbar: 0,
	contextMenu: 0,
	chromeBookmarks: 0,
	legacyUnknown: 0,
	authors: 0,
	lastCaptureAt: null,
	lastSavedAt: null,
	lastPostedAt: null,
	media: 0,
	mediaStored: 0,
	runtime: null,
	...patch,
});

describe("sourcePresentation", () => {
	test("planned and disabled states outrank connection state", () => {
		expect(
			sourcePresentation(
				row({ support: "coming_next" }),
				extension("disconnected"),
			).state,
		).toBe("coming_next");
		expect(
			sourcePresentation(row({ enabled: false }), extension("disconnected"))
				.state,
		).toBe("disabled");
	});

	test("recent or numerous items cannot hide a disconnected extension", () => {
		expect(
			sourcePresentation(
				row({ items: 2_000, lastSavedAt: 1_000 }),
				extension("disconnected"),
			).state,
		).toBe("disconnected");
	});

	test("outstanding work and failures outrank ready", () => {
		expect(
			sourcePresentation(
				row({
					runtime: {
						phase: "idle",
						queued: 0,
						uploading: 0,
						retrying: 0,
						failed: 2,
					},
				}),
				extension(),
			).state,
		).toBe("failed");
		expect(
			sourcePresentation(
				row({
					runtime: {
						phase: "idle",
						queued: 3,
						uploading: 0,
						retrying: 0,
						failed: 0,
					},
				}),
				extension(),
			).state,
		).toBe("queued");
		expect(
			sourcePresentation(
				row({
					runtime: {
						phase: "running",
						queued: 0,
						uploading: 0,
						retrying: 0,
						failed: 0,
					},
				}),
				extension(),
			).state,
		).toBe("running");
	});

	test("experimental is explicit after operational failures are clear", () => {
		expect(
			sourcePresentation(row({ support: "experimental" }), extension()).state,
		).toBe("experimental");
	});

	test("labels extension connection without inventing a version", () => {
		expect(extensionLabel(extension())).toBe("Connected · v0.1.0");
		expect(extensionLabel(extension("never_connected"))).toBe(
			"Extension never connected",
		);
	});
});
