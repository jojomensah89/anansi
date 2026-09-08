import { describe, expect, test } from "bun:test";
import {
	EXTENSION_PLATFORM_SOURCES,
	LIVE_CAPTURE_SOURCES,
	MANUAL_CAPTURE_SOURCES,
	PAGE_IMPORT_SOURCES,
	RETAINED_PARSING_SOURCES,
	SESSION_IMPORT_SOURCES,
	SHIPPED_CAPTURE_SOURCES,
	SOURCE_CAPABILITIES,
	SOURCE_IDS,
	TOGGLEABLE_SOURCES,
	VISIBLE_LIBRARY_SOURCES,
	captureMethodsForSource,
	isExtensionPlatformSource,
	isManualCaptureSource,
	isPageImportSource,
	isRetainedParsingSource,
	isSessionImportSource,
	isSource,
	isToggleableSource,
	retainedCaptureMethodsForSource,
	sourceCapability,
	supportsCaptureMethod,
	supportsRetainedCaptureMethod,
	validateSourceCapabilityFacts,
} from "./capabilities.ts";

describe("source capability views", () => {
	test("keeps retained, visible, extension, import, and toggle sets distinct", () => {
		expect(SOURCE_IDS).toEqual(["x", "reddit", "web", "github", "tiktok"]);
		expect(RETAINED_PARSING_SOURCES).toEqual([
			"x",
			"reddit",
			"web",
			"github",
			"tiktok",
		]);
		expect(VISIBLE_LIBRARY_SOURCES).toEqual(["x", "reddit", "web", "github"]);
		expect(EXTENSION_PLATFORM_SOURCES).toEqual(["x", "reddit", "github"]);
		expect(PAGE_IMPORT_SOURCES).toEqual(["x"]);
		expect(SESSION_IMPORT_SOURCES).toEqual(["reddit", "github"]);
		expect(LIVE_CAPTURE_SOURCES).toEqual(["x", "reddit", "github"]);
		expect(MANUAL_CAPTURE_SOURCES).toEqual(["web"]);
		expect(TOGGLEABLE_SOURCES).toEqual(["x", "reddit", "github"]);
		expect(SHIPPED_CAPTURE_SOURCES).toEqual([
			"x",
			"reddit",
			"github",
			"web",
		]);
	});

	test("preserves paused TikTok parsing without shipping its capture", () => {
		expect(isRetainedParsingSource("tiktok")).toBe(true);
		expect(isExtensionPlatformSource("tiktok")).toBe(false);
		expect(isManualCaptureSource("tiktok")).toBe(false);
		expect(isToggleableSource("tiktok")).toBe(false);
		expect(captureMethodsForSource("tiktok")).toEqual([]);
		expect(retainedCaptureMethodsForSource("tiktok")).toEqual([
			"platform_event",
			"platform_import",
		]);
		expect(supportsCaptureMethod("tiktok", "platform_event")).toBe(false);
		expect(
			supportsRetainedCaptureMethod("tiktok", "platform_event"),
		).toBe(true);
	});

	test("describes Web as manual capture and platform imports independently", () => {
		expect(sourceCapability("web")).toMatchObject({
			retainedParsing: true,
			productVisible: true,
			extensionPlatform: false,
			importMode: null,
			liveCapture: false,
			manualCapture: true,
			toggleable: false,
		});
		expect(captureMethodsForSource("web")).toEqual([
			"toolbar",
			"context_menu",
			"chrome_bookmark",
		]);
		expect(isPageImportSource("x")).toBe(true);
		expect(isSessionImportSource("reddit")).toBe(true);
		expect(supportsCaptureMethod("web", "toolbar")).toBe(true);
		expect(supportsCaptureMethod("web", "platform_event")).toBe(false);
	});

	test("rejects unknown identities and inconsistent capability facts", () => {
		expect(isSource("instagram")).toBe(false);
		expect(sourceCapability("instagram")).toBeNull();
		expect(validateSourceCapabilityFacts(SOURCE_CAPABILITIES)).toEqual({ ok: true });
		expect(
			validateSourceCapabilityFacts([
				{ ...SOURCE_CAPABILITIES[0], source: "instagram" },
			]),
		).toMatchObject({ ok: false, error: { code: "invalid_shape" } });
		expect(
			validateSourceCapabilityFacts([
				{ ...SOURCE_CAPABILITIES[0], source: "x", manualCapture: true },
			]),
		).toMatchObject({ ok: false, error: { code: "inconsistent_facts" } });
	});

	test("rejects one-way capture facts and methods outside retained parsing", () => {
		const x = SOURCE_CAPABILITIES[0];
		const web = SOURCE_CAPABILITIES.find((entry) => entry.source === "web");
		if (!web) throw new Error("web capability row missing");
		const inconsistent = (candidate: unknown) =>
			expect(validateSourceCapabilityFacts([candidate])).toMatchObject({
				ok: false,
				error: { code: "inconsistent_facts" },
			});

		// Each direction is required: a live source must advertise an event,
		// and a current platform event must have liveCapture enabled.
		inconsistent({ ...x, liveCapture: false });
		inconsistent({ ...x, captureMethods: ["platform_import"] });
		// Manual methods cannot be current when manualCapture is false, and a
		// current method cannot be introduced without retaining its parser.
		inconsistent({ ...web, manualCapture: false });
		inconsistent({
			...x,
			retainedCaptureMethods: ["platform_event"],
		});
	});

	test("enforces import, platform, and manual method combinations", () => {
		const x = SOURCE_CAPABILITIES[0];
		const web = SOURCE_CAPABILITIES.find((entry) => entry.source === "web");
		if (!web) throw new Error("web capability row missing");
		const inconsistent = (candidate: unknown) =>
			expect(validateSourceCapabilityFacts([candidate])).toMatchObject({
				ok: false,
				error: { code: "inconsistent_facts" },
			});

		inconsistent({
			...x,
			extensionPlatform: false,
		});
		inconsistent({
			...x,
			importMode: null,
		});
		inconsistent({
			...web,
			captureMethods: ["toolbar", "platform_event"],
			retainedCaptureMethods: [
				"toolbar",
				"platform_event",
				"platform_import",
			],
			liveCapture: true,
			manualCapture: true,
			extensionPlatform: true,
			importMode: "page",
			toggleable: true,
		});
	});
});
