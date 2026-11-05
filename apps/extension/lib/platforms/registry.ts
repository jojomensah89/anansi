import type { ExtensionPlatformSource, SessionImportSource } from "@anansi/sources";
import type { PlatformCaptureAdapter } from "./capture-adapter.ts";
import { githubCaptureAdapter } from "./adapters/github.ts";
import { redditCaptureAdapter } from "./adapters/reddit.ts";
import { tiktokCaptureAdapter } from "./adapters/tiktok.ts";
import { xCaptureAdapter } from "./adapters/x.ts";

/** Every shipped platform adapter is registered here at build time. */
export const PLATFORM_CAPTURE_ADAPTERS = {
	x: xCaptureAdapter,
	reddit: redditCaptureAdapter,
	github: githubCaptureAdapter,
	tiktok: tiktokCaptureAdapter,
} satisfies { [S in ExtensionPlatformSource]: PlatformCaptureAdapter<S> };

export function captureAdapter<S extends ExtensionPlatformSource>(source: S): PlatformCaptureAdapter<S> {
	return PLATFORM_CAPTURE_ADAPTERS[source] as unknown as PlatformCaptureAdapter<S>;
}

export function captureSourceFromUrl(value: string): ExtensionPlatformSource | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		for (const source of Object.keys(PLATFORM_CAPTURE_ADAPTERS) as ExtensionPlatformSource[]) {
			if (captureAdapter(source).hosts.includes(url.hostname.toLowerCase())) return source;
		}
	} catch { /* Invalid URLs are not platform pages. */ }
	return null;
}

export function isPlatformSourceUrl(value: unknown, source: ExtensionPlatformSource): value is string {
	if (typeof value !== "string" || value.length > 2_000) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username === "" && url.password === "" &&
			captureAdapter(source).hosts.includes(url.hostname.toLowerCase());
	} catch { return false; }
}

export function isPlatformExternalId(value: unknown, source: ExtensionPlatformSource): value is string {
	return captureAdapter(source).isExternalId(value);
}

export function platformCanonicalUrl(source: ExtensionPlatformSource, externalId: string): string {
	return captureAdapter(source).canonicalUrl(externalId);
}

export function isExpectedPlatformImportTab(source: ExtensionPlatformSource, value: string): boolean {
	return captureAdapter(source).isExpectedImportTab(value);
}

export function isSessionCaptureSource(source: ExtensionPlatformSource): source is SessionImportSource {
	return captureAdapter(source).importMode === "session";
}

export function platformTabPatterns(source: ExtensionPlatformSource): readonly string[] {
	return captureAdapter(source).tabPatterns;
}

export function platformEntryUrl(source: ExtensionPlatformSource): string {
	return captureAdapter(source).entryUrl;
}

export function shouldRefreshTopOnResume(source: ExtensionPlatformSource): boolean {
	return captureAdapter(source).refreshTopOnResume === true;
}

export type { AnyPlatformCaptureAdapter } from "./capture-adapter.ts";

