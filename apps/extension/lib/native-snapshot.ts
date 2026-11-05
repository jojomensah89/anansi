import { isExtensionPlatformSource, type ExtensionPlatformSource, type NormalizedItem } from "@anansi/sources";
import { captureAdapter } from "./platforms/registry.ts";
import { completeNativeItemWithAdapter, nativeItemsFromPayloadWithAdapter } from "./platforms/native-snapshot-core.ts";

export function completeNativeItem(item: NormalizedItem): boolean {
	if (!isExtensionPlatformSource(item.source)) return false;
	const adapter = captureAdapter(item.source).nativeSnapshot;
	return completeNativeItemWithAdapter(item, adapter);
}

export function nativeItemsFromPayload(source: ExtensionPlatformSource, raw: unknown, now: number): NormalizedItem[] {
	return nativeItemsFromPayloadWithAdapter(source, raw, now, captureAdapter(source).nativeSnapshot);
}

export function nativeItemFromDocument(source: ExtensionPlatformSource, id: string, doc: Document, now: number): NormalizedItem | undefined {
	const adapter = captureAdapter(source).nativeSnapshot;
	const item = adapter.fromDocument(id, doc, now, (raw) => nativeItemsFromPayload(source, raw, now));
	return item && completeNativeItemWithAdapter(adapter.sanitize(item), adapter) ? adapter.sanitize(item) : undefined;
}

export function createNativeSnapshotCache(source: ExtensionPlatformSource) {
	const items = new Map<string, { item: NormalizedItem; at: number }>();
	const remember = (item: NormalizedItem) => {
		items.delete(item.externalId);
		items.set(item.externalId, { item, at: Date.now() });
		while (items.size > 100) items.delete(items.keys().next().value!);
	};
	const collect = (raw: unknown) => {
		for (const item of nativeItemsFromPayload(source, raw, Math.floor(Date.now() / 1000))) remember(item);
	};
	const get = (id: string) => {
		const cached = items.get(id);
		if (cached && Date.now() - cached.at < 300_000) return cached.item;
		const item = nativeItemFromDocument(source, id, document, Math.floor(Date.now() / 1000));
		if (item) remember(item);
		return item;
	};
	// Snapshot before the site's native handler can remove or recycle the target.
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const root = target?.closest('article, shreddit-post, .thing, .Box-row, [data-e2e="recommend-list-item-container"], main');
		if (!root) return;
		for (const id of captureAdapter(source).nativeSnapshot.idsFromClickTarget(root)) get(id);
	}, true);
	const originalFetch = window.fetch;
	window.fetch = Object.assign(function(this: unknown, ...args: Parameters<typeof fetch>) {
		const response = originalFetch.apply(this, args);
		void response.then((res) => {
			if (!res.ok || !res.headers.get("content-type")?.includes("json") || Number(res.headers.get("content-length")) > 2_000_000) return;
			void res.clone().text().then((text) => { if (text.length <= 2_000_000) collect(JSON.parse(text)); }).catch(() => {});
		}).catch(() => {});
		return response;
	}, originalFetch);
	return { get, collect };
}
