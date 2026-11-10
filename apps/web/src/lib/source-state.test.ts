import { describe, expect, test } from "bun:test";
import type { ExtensionHealth, SourceRow } from "./api.ts";
import { extensionLabel, extensionStatus, sourcePresentation } from "./source-state.ts";

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
		const failure = (lastErrorCode: string | undefined, failed: number) =>
			sourcePresentation(
				row({
					runtime: { phase: "idle", queued: 0, uploading: 0, retrying: 0, failed, ...(lastErrorCode ? { lastErrorCode } : {}) },
				}),
				extension(),
			).text;
		expect(failure("queue_full", 0)).toBe("Capture queue is full, delivery is catching up");
		expect(failure("capture_failed", 0)).toBe("Last capture failed");
		expect(failure("not_signed_in", 0)).toBe("Sign in required");
		expect(failure(undefined, 2)).toBe("2 captures failed");
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

	test("a supported GitHub source is operational rather than planned", () => {
		const presentation = sourcePresentation(
			row({ source: "github", name: "GitHub stars", items: 25 }),
			extension(),
		);
		expect(presentation).toEqual({ state: "ready", text: "Ready", tone: "ok" });
	});

	test("TikTok ready state points to the extension import", () => {
		expect(sourcePresentation(row({ source: "tiktok", name: "TikTok favorites" }), extension())).toEqual({
			state: "ready", text: "Ready to import", tone: "ok",
		});
	});

	test("labels extension connection without inventing a version", () => {
		expect(extensionLabel(extension())).toBe("Connected · v0.1.0");
		expect(extensionLabel(extension("never_connected"))).toBe(
			"Extension never connected",
		);
	});
});

describe("extension status dot", () => {
	test("one meaning per state: online green, syncing accent, lost amber, never grey", () => {
		expect(extensionStatus(extension())).toMatchObject({ state: "online", tone: "ok", label: "Extension online" });
		expect(extensionStatus(extension(), true)).toMatchObject({ state: "syncing", tone: "accent" });
		const running = { ...extension(), sources: { x: { phase: "running", queued: 0, uploading: 0, retrying: 0, failed: 0 } } } as ExtensionHealth;
		expect(extensionStatus(running).state).toBe("syncing");
		expect(extensionStatus(extension("disconnected"))).toMatchObject({ state: "offline", tone: "warn", label: "Extension offline" });
		expect(extensionStatus(extension("never_connected"))).toMatchObject({ state: "never", tone: "muted" });
		// A lost connection never reads as syncing, even with a stale running phase.
		expect(extensionStatus({ ...running, connection: "disconnected" }).state).toBe("offline");
		expect(extensionStatus(null)).toMatchObject({ state: "unknown", tone: "muted" });
	});
});
