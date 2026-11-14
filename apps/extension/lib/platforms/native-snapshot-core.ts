import { isExtensionPlatformSource, parseBookmarkCapture, type ExtensionPlatformSource, type NormalizedItem } from "@anansi/sources";
import { NATIVE_SNAPSHOT_LIMITS, type NativeSnapshotAdapter } from "./capture-adapter.ts";

type PlainRecord = Record<string, unknown>;

function asRecord(value: unknown): PlainRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as PlainRecord : undefined;
}

export function completeNativeItemWithAdapter(item: NormalizedItem, adapter: NativeSnapshotAdapter): boolean {
	if (!isExtensionPlatformSource(item.source)) return false;
	if (typeof item.body !== "string" || item.body.length > NATIVE_SNAPSHOT_LIMITS.maxTextChars) return false;
	if (item.title !== undefined && (typeof item.title !== "string" || item.title.length > NATIVE_SNAPSHOT_LIMITS.maxTextChars)) return false;
	if (item.body.trim().length === 0 && !item.title?.trim() && item.media.length === 0) return false;
	if (!adapter.matchesIdentity(item)) return false;
	if (!adapter.hasCompleteProviderData(item.raw, NATIVE_SNAPSHOT_LIMITS.maxObjects)) return false;
	try {
		return parseBookmarkCapture({ schemaVersion: 1, payloadType: "item_event", eventId: "snapshot-validation",
			source: item.source, action: "save", externalId: item.externalId, canonicalUrl: item.url,
			observedAt: Math.max(1, item.savedAt), captureMethod: "platform_event", normalizedItem: item }).ok;
	} catch { return false; }
}

export function nativeItemsFromPayloadWithAdapter(
	source: ExtensionPlatformSource,
	raw: unknown,
	now: number,
	adapter: NativeSnapshotAdapter,
): NormalizedItem[] {
	const result = new Map<string, NormalizedItem>();
	const pending: unknown[] = [raw];
	const visitedObjects = new Set<object>();
	let visited = 0;
	while (pending.length && visited++ < NATIVE_SNAPSHOT_LIMITS.maxObjects) {
		const value = pending.pop();
		if (!value || typeof value !== "object" || visitedObjects.has(value)) continue;
		visitedObjects.add(value);
		const obj = Array.isArray(value) ? undefined : asRecord(value);
		if (obj) {
			try {
				for (const item of adapter.parseObject(obj, now)) {
					if (item.source !== source || !adapter.hasCompleteProviderData(item.raw, NATIVE_SNAPSHOT_LIMITS.maxObjects)) continue;
					const snapshot = adapter.sanitize(item);
					if (snapshot.source === source && completeNativeItemWithAdapter(snapshot, adapter)) result.set(snapshot.externalId, snapshot);
				}
			} catch { /* Ignore unrelated or malformed provider objects. */ }
		}
		try {
			let children = 0;
			const values = Array.isArray(value) ? value : obj ? Object.values(obj) : [];
			for (const child of values) {
				if (!child || typeof child !== "object") continue;
				if (++children > NATIVE_SNAPSHOT_LIMITS.maxChildren) break;
				pending.push(child);
			}
		} catch { /* Ignore provider objects with unexpected accessors. */ }
	}
	return [...result.values()];
}
