import {
	EXTENSION_PLATFORM_SOURCES,
	type ExtensionPlatformSource,
	type ExtensionRemoteConfig,
} from "@anansi/sources";

/** The sources eligible for the one-click first history import. */
export function configuredImportAllSources(
	config: ExtensionRemoteConfig | null,
): ExtensionPlatformSource[] {
	if (!config?.enabled) return [];
	const configured = new Set(config.sources.map((entry) => entry.source));
	return EXTENSION_PLATFORM_SOURCES.filter((source) => configured.has(source));
}

/** Keep source completion decisions in the durable SourceRuns store. */
export async function initialImportSources(
	config: ExtensionRemoteConfig | null,
	isDue: (source: ExtensionPlatformSource) => Promise<boolean>,
): Promise<ExtensionPlatformSource[]> {
	const configured = configuredImportAllSources(config);
	const due = await Promise.all(
		configured.map(async (source) => (await isDue(source) ? source : null)),
	);
	return due.filter((source): source is ExtensionPlatformSource => source !== null);
}

/** Start every source independently; one rejected source must not block the rest. */
export function runImportAll(
	sources: readonly ExtensionPlatformSource[],
	start: (source: ExtensionPlatformSource) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
	return Promise.allSettled(sources.map((source) => start(source)));
}
