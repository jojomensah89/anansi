import { parseItemList, type NormalizedItem } from "@anansi/sources";
import { NATIVE_SNAPSHOT_LIMITS, type NativeSnapshotAdapter, type PlatformCaptureAdapter } from "../capture-adapter.ts";
import { isProfileView, profileUrl } from "../tiktok.ts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function sourcePathId(item: NormalizedItem): string | undefined {
	try {
		const url = new URL(item.url);
		if (url.protocol !== "https:" || url.username || url.password || (url.hostname !== "tiktok.com" && url.hostname !== "www.tiktok.com")) return;
		return url.pathname.replace(/\/$/, "").match(/^\/(?:@[^/]+\/)?video\/(\d+)$/)?.[1];
	} catch { return; }
}

function parseObject(value: RecordValue, now: number): NormalizedItem[] {
	if (typeof value.id !== "string" || typeof value.desc !== "string" || !asRecord(value.author)?.uniqueId || !value.video) return [];
	return parseItemList({ itemList: [value] }, { importedAt: now });
}

function href(element: Element | null, baseUrl?: string): string | undefined {
	const value = element?.getAttribute("href");
	if (!value) return;
	try { return new URL(value, baseUrl || element!.ownerDocument.location?.href || "https://www.tiktok.com").href; } catch { return; }
}

function hydrationItem(id: string, doc: Document, now: number, parsePayload: (raw: unknown) => NormalizedItem[]): NormalizedItem | undefined {
	let scannedChars = 0;
	for (const scriptId of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
		const text = doc.getElementById(scriptId)?.textContent;
		if (!text?.trim()) continue;
		if (text.length > NATIVE_SNAPSHOT_LIMITS.maxPayloadChars - scannedChars) return;
		scannedChars += text.length;
		try { const payload: unknown = JSON.parse(text); const item = parsePayload(payload).find((candidate) => candidate.externalId === id); if (item) return item; }
		catch { /* Ignore absent, malformed, or unrelated hydration state. */ }
	}
	return;
}

function fromDocument(id: string, doc: Document, now: number, parsePayload: (raw: unknown) => NormalizedItem[]): NormalizedItem | undefined {
	const hydrated = hydrationItem(id, doc, now, parsePayload);
	if (hydrated) return hydrated;
	const links = [...doc.querySelectorAll("a[href]")];
	const link = links.find((a) => href(a, "https://www.tiktok.com")?.match(/\/video\/(\d+)/)?.[1] === id);
	const root = link?.closest('article, [data-e2e="recommend-list-item-container"], [data-e2e="browse-video"]');
	if (!root || root.querySelector('[data-e2e="more-button"]')) return;
	const text = root.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]')?.textContent?.trim();
	if (!text) return;
	return { source: "tiktok", externalId: id, savedAt: now, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {}, kind: "post", url: href(link ?? null, "https://www.tiktok.com")!, body: text };
}

const nativeSnapshot: NativeSnapshotAdapter = {
	parseObject,
	matchesIdentity: (item) => sourcePathId(item) === item.externalId,
	hasCompleteProviderData: () => true,
	sanitize: (item) => ({ ...item, raw: {} }),
	fromDocument,
	idsFromClickTarget(root) {
		return [...root.querySelectorAll("a[href]")].slice(0, 100)
			.map((link) => href(link)?.match(/\/video\/(\d+)/)?.[1])
			.filter((id): id is string => Boolean(id));
	},
};

export const tiktokCaptureAdapter = {
	source: "tiktok",
	hosts: ["www.tiktok.com", "tiktok.com"],
	tabPatterns: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
	entryUrl: "https://www.tiktok.com/",
	importMode: "page",
	isExternalId: (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value),
	canonicalUrl: (id: string) => `https://www.tiktok.com/video/${id}`,
	parsePage: (raw: unknown, importedAt: number) => parseItemList(raw, { importedAt }),
	isExpectedImportTab(value: string) {
		try { const host = new URL(value).hostname; return host === "tiktok.com" || host === "www.tiktok.com"; }
		catch { return false; }
	},
	async preparePageImport(context) {
		await context.setMessage("finding your favorites…");
		await context.identify();
		const handle = await context.waitForIdentity();
		const destination = handle && profileUrl(handle);
		if (!destination) return { ready: false, code: "capture_failed", message: "could not identify your TikTok account; reload TikTok and retry" };
		const currentUrl = await context.currentUrl();
		if (!currentUrl || !isProfileView(currentUrl, handle)) {
			if (!(await context.navigate(destination)) || !(await context.configure())) {
				return { ready: false, code: "platform_request_failed", message: "could not open your TikTok Favorites page" };
			}
		}
		return { ready: true };
	},
	protocol: {
		events: { actions: ["ready", "saved", "observed", "identified", "scanned", "bookmark", "error"], ready: "relay-only", pageRequiresRunId: false, doneRequiresRunId: false, errorRequiresRunId: true },
		commands: { actions: ["ready", "configure", "identify", "scan"], requiredRunIdActions: [] },
	},
	nativeSnapshot,
} satisfies PlatformCaptureAdapter<"tiktok">;

