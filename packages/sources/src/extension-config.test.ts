import { describe, expect, test } from "bun:test";
import {
	EXTENSION_PLATFORM_SOURCES,
	SHIPPED_CAPTURE_SOURCES,
	parseExtensionConfig,
	validateExtensionConfig,
} from "./index.ts";

const source = (name: (typeof EXTENSION_PLATFORM_SOURCES)[number]) => ({
	source: name,
	host: `${name}.example.test`,
	mode: "page" as const,
});

const valid = () => ({
	version: 1,
	enabled: true,
	ingest: "https://anansi.example.test/api/ingest",
	ingestProtocolVersion: 2,
	features: {
		captureV2: Object.fromEntries(
			SHIPPED_CAPTURE_SOURCES.map((name) => [name, true]),
		),
		chromeBookmarks: true,
	},
	sources: EXTENSION_PLATFORM_SOURCES.map(source),
});

describe("extension config contract", () => {
	test("parses the same wire shape used by the server and popup/background", () => {
		const result = parseExtensionConfig(valid());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.sources.map((entry) => entry.source)).toEqual([
			"x",
			"reddit",
			"github",
		]);
		expect(validateExtensionConfig(valid())).toBe(true);
	});

	test("allows a server-disabled source to be absent while retaining known rows", () => {
		const config = valid();
		config.sources = config.sources.filter((entry) => entry.source !== "reddit");
		const result = parseExtensionConfig(config);
		expect(result.ok).toBe(true);
	});

	test("rejects unknown, duplicate, malformed, and hidden source instructions", () => {
		const unknown = {
			...valid(),
			sources: [source("x"), { ...source("reddit"), source: "instagram" }],
		};
		expect(parseExtensionConfig(unknown as unknown)).toMatchObject({
			ok: false,
			error: { code: "unknown_source" },
		});

		const duplicate = valid();
		duplicate.sources = [source("x"), source("x")];
		expect(parseExtensionConfig(duplicate)).toMatchObject({
			ok: false,
			error: { code: "duplicate_source" },
		});

		const malformed = {
			...valid(),
		sources: [{ ...source("x"), pageLimit: 0 }],
		};
		expect(parseExtensionConfig(malformed as unknown)).toMatchObject({
			ok: false,
			error: { code: "inconsistent_source" },
		});

		const hidden = {
			...valid(),
			features: {
				...valid().features,
				captureV2: { tiktok: true },
			},
		};
		expect(parseExtensionConfig(hidden as unknown)).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});

	test("rejects credentials in URLs and extra keys at the config seam", () => {
		const credentials = valid();
		credentials.ingest = "https://user:password@anansi.example.test/api/ingest";
		expect(parseExtensionConfig(credentials)).toMatchObject({ ok: false });

		const extra = { ...valid(), unexpected: true };
		expect(parseExtensionConfig(extra)).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});
});
