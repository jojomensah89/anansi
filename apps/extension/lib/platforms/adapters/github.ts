import { parseStarredPage, type NormalizedItem } from "@anansi/sources";
import { validatedGitHubStarsPageUrl } from "../github.ts";
import type { NativeSnapshotAdapter, PlatformCaptureAdapter } from "../capture-adapter.ts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function sourcePathId(item: NormalizedItem): string | undefined {
	try {
		const url = new URL(item.url);
		if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "github.com") return;
		const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
		return parts.length === 2 ? parts.join("/").toLowerCase() : undefined;
	} catch { return; }
}

function parseObject(value: RecordValue, now: number): NormalizedItem[] {
	if (!value.full_name || !value.html_url || !value.owner) return [];
	return parseStarredPage({ starred: [value] }, { importedAt: now });
}

function href(element: Element | null, baseUrl?: string): string | undefined {
	const value = element?.getAttribute("href");
	if (!value) return;
	try { return new URL(value, baseUrl || element!.ownerDocument.location?.href || "https://github.com").href; } catch { return; }
}

function fromDocument(id: string, doc: Document, now: number): NormalizedItem | undefined {
	const links = [...doc.querySelectorAll("a[href]")];
	const match = links.find((a) => {
		try { const url = new URL(href(a, "https://github.com")!); return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.toLowerCase().replace(/\/$/, "") === `/${id.toLowerCase()}`; }
		catch { return false; }
	});
	let current = false;
	try { const location = new URL(doc.location?.href ?? ""); current = location.protocol === "https:" && location.hostname === "github.com" && location.pathname.toLowerCase().replace(/\/$/, "") === `/${id.toLowerCase()}`; }
	catch { /* Detached documents may not have a location. */ }
	if (!current && !match) return;
	const root = current ? doc.querySelector("main") : match?.closest("article, li, .col-12, .Box-row");
	if (!root) return;
	const descriptionElement = root.querySelector('[itemprop="about"], [data-testid="repository-description"], p.f4, p[itemprop="description"], .color-fg-muted.mb-3');
	if (!descriptionElement) return;
	const description = descriptionElement.textContent?.trim() ?? "";
	return { source: "github", externalId: id, savedAt: now, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {}, kind: "repo", url: `https://github.com/${id}`, title: id, body: description, authorHandle: id.split("/")[0] };
}

const nativeSnapshot: NativeSnapshotAdapter = {
	parseObject,
	matchesIdentity: (item) => sourcePathId(item) === item.externalId.toLowerCase(),
	hasCompleteProviderData: () => true,
	sanitize: (item) => ({ ...item, raw: {} }),
	fromDocument,
	idsFromClickTarget(root) {
		const ids: string[] = [];
		for (const link of [...root.querySelectorAll("a[href]")].slice(0, 100)) {
			const value = href(link);
			if (!value) continue;
			try { const url = new URL(value); if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) ids.push(url.pathname.slice(1).replace(/\/$/, "").toLowerCase()); }
			catch { /* Ignore malformed links. */ }
		}
		return ids;
	},
};

export const githubCaptureAdapter = {
	source: "github",
	hosts: ["github.com"],
	tabPatterns: ["https://github.com/*"],
	entryUrl: "https://github.com/stars",
	importMode: "session",
	isExternalId: (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(value),
	canonicalUrl: (id: string) => `https://github.com/${id}`,
	parsePage: (raw: unknown, importedAt: number) => parseStarredPage(raw, { importedAt }),
	isExpectedImportTab(value: string) {
		return validatedGitHubStarsPageUrl(value, value) !== null;
	},
	protocol: {
		events: { actions: ["ready", "saved", "page", "done", "bookmark", "error"], ready: "relay-only", pageRequiresRunId: false, doneRequiresRunId: false, errorRequiresRunId: false },
		commands: { actions: ["ready", "configure", "backfill"], requiredRunIdActions: [] },
	},
	nativeSnapshot,
} satisfies PlatformCaptureAdapter<"github">;

