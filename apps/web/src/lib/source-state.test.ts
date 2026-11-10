import { describe, expect, test } from "bun:test";
import type { ExtensionHealth, SourceRow } from "./api.ts";
import { extensionLabel, extensionStatus, sourceAction, sourcePresentation } from "./source-state.ts";

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
		expect(failure("not_signed_in", 0)).toBe("Sign in to X, then try again");
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

describe("limited sources and the row action", () => {
	const act = (patch: Partial<SourceRow>, ext = extension()) => {
		const source = row(patch);
		return sourceAction(source, sourcePresentation(source, ext));
	};

	test("live saves without history read as limited and offer the import", () => {
		const source = row({ source: "reddit", items: 186, live: 186 });
		expect(sourcePresentation(source, extension())).toEqual({ state: "limited", text: "Live only · history not imported", tone: "faint" });
		expect(act({ source: "reddit", items: 186, live: 186 })).toBe("import");
	});

	test("legacy-only or imported sources are not limited", () => {
		expect(sourcePresentation(row({ items: 4, legacyUnknown: 4 }), extension()).state).toBe("ready");
		expect(sourcePresentation(row({ items: 9, live: 3, imported: 6 }), extension()).state).toBe("ready");
		expect(act({ items: 9, live: 3, imported: 6 })).toBe("view");
	});

	test("manual capture never offers an import", () => {
		expect(sourcePresentation(row({ source: "web", mode: "manual", items: 5, live: 5 }), extension()).state).toBe("ready");
		expect(act({ source: "web", mode: "manual", items: 0 })).toBeNull();
		expect(act({ source: "web", mode: "manual", items: 5, toolbar: 5 })).toBe("view");
	});

	test("an empty importable source offers the import", () => {
		expect(act({ source: "tiktok", mode: "session" })).toBe("import");
	});

	test("failures retry, pauses resume, turned-off sources offer nothing", () => {
		const runtime = { phase: "idle" as const, queued: 0, uploading: 0, retrying: 0, failed: 0 };
		expect(act({ items: 3, runtime: { ...runtime, lastErrorCode: "not_signed_in" } })).toBe("retry");
		expect(act({ items: 3, runtime: { ...runtime, paused: true } })).toBe("resume");
		expect(act({ items: 3, enabled: false })).toBeNull();
		expect(act({ support: "coming_next" })).toBeNull();
	});

	test("an absent extension makes rows wait without a warning tone", () => {
		const presentation = sourcePresentation(row({ items: 3, live: 3 }), extension("disconnected"));
		expect(presentation).toMatchObject({ state: "disconnected", tone: "faint" });
		expect(sourcePresentation(row(), extension("never_connected")).text).toBe("Waiting for the extension");
	});
});
