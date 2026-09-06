export interface ServerCache<T> {
	serverOrigin: string;
	at: number;
	value: T;
}

/** Canonical cache identity: scheme, host, and effective port only. */
export function normalizeServerOrigin(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		if (
			url.protocol === "http:" &&
			url.hostname !== "localhost" &&
			url.hostname !== "127.0.0.1" &&
			url.hostname !== "[::1]"
		) return null;
		return url.origin;
	} catch {
		return null;
	}
}

/** Return a cache entry only when it belongs to this exact server origin. */
export function cachedForServer<T>(
	cache: ServerCache<T> | null,
	server: string,
	now: number,
	ttlMs: number,
	allowStale = false,
): T | null {
	const origin = normalizeServerOrigin(server);
	if (!cache || !origin || cache.serverOrigin !== origin) return null;
	if (!allowStale && now - cache.at >= ttlMs) return null;
	return cache.value;
}
