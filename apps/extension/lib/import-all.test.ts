import { describe, expect, test } from "bun:test";
import type { ExtensionRemoteConfig, ExtensionPlatformSource } from "@anansi/sources";
import {
	configuredImportAllSources,
	initialImportSources,
	runImportAll,
} from "./import-all.ts";

const source = (name: ExtensionPlatformSource) => ({
	source: name,
	host: `${name}.example.com`,
	mode: "page" as const,
});

const config = (
	sources: ExtensionPlatformSource[] = ["x", "reddit", "github"],
): ExtensionRemoteConfig => ({
	version: 1,
	enabled: true,
	ingest: "https://anansi.example.com/api/ingest",
	sources: sources.map(source),
});

describe("import all", () => {
	test("selects configured platform sources in catalogue order", () => {
		expect(configuredImportAllSources(config(["github", "x"]))).toEqual([
			"x",
			"github",
		]);
		expect(configuredImportAllSources({ ...config(), enabled: false })).toEqual([]);
		expect(configuredImportAllSources(null)).toEqual([]);
	});

	test("selects only sources whose durable initial import is still due", async () => {
		const due = await initialImportSources(config(), async (sourceName) => sourceName !== "reddit");
		expect(due).toEqual(["x", "github"]);
	});

	test("starts every source even when one import rejects", async () => {
		const started: string[] = [];
		const result = await runImportAll(["x", "reddit", "github"], async (sourceName) => {
			started.push(sourceName);
			if (sourceName === "reddit") throw new Error("source failed");
		});

		expect(started).toEqual(["x", "reddit", "github"]);
		expect(result.map((entry) => entry.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
		]);
	});
});
