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
		)
			return null;
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

const PERSISTED_CONFIG_KEY = "anansiExtensionConfigCacheV1";

export interface ConfigCacheStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

interface PersistedConfigRecord {
	version: 1;
	serverOrigin: string;
	tokenFingerprint: string;
	at: number;
	value: unknown;
}

function isPersistedConfigRecord(
	value: unknown,
): value is PersistedConfigRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 5 &&
		["version", "serverOrigin", "tokenFingerprint", "at", "value"].every(
			(key) => key in record,
		) &&
		record.version === 1 &&
		typeof record.serverOrigin === "string" &&
		normalizeServerOrigin(record.serverOrigin) === record.serverOrigin &&
		typeof record.tokenFingerprint === "string" &&
		/^[0-9a-f]{64}$/.test(record.tokenFingerprint) &&
		typeof record.at === "number" &&
		Number.isSafeInteger(record.at) &&
		record.at >= 0
	);
}

async function tokenFingerprint(token: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Keep a validated server config across MV3 worker restarts without storing another token. */
export function createPersistedConfigCache<T>(options: {
	storage: ConfigCacheStorage;
	validate: (value: unknown) => T | null;
}) {
	let operations: Promise<void> = Promise.resolve();
	const runExclusive = <R>(operation: () => Promise<R>): Promise<R> => {
		const result = operations.then(operation);
		operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const discard = async (): Promise<void> => {
		await options.storage.remove(PERSISTED_CONFIG_KEY);
	};
	return {
		async load(
			server: string,
			token: string,
			now: number,
		): Promise<ServerCache<T> | null> {
			const origin = normalizeServerOrigin(server);
			if (!origin || !Number.isSafeInteger(now) || now < 0) return null;
			return runExclusive(async () => {
				const stored = (await options.storage.get(PERSISTED_CONFIG_KEY))[
					PERSISTED_CONFIG_KEY
				];
				if (stored === undefined) return null;
				if (!isPersistedConfigRecord(stored)) {
					await discard();
					return null;
				}
				if (
					stored.serverOrigin !== origin ||
					stored.tokenFingerprint !== (await tokenFingerprint(token))
				) {
					return null;
				}
				if (stored.at > now) {
					await discard();
					return null;
				}
				const value = options.validate(stored.value);
				if (value === null) {
					await discard();
					return null;
				}
				return { serverOrigin: origin, at: stored.at, value };
			});
		},
		async save(
			server: string,
			token: string,
			value: unknown,
			at: number,
		): Promise<ServerCache<T>> {
			const origin = normalizeServerOrigin(server);
			const validated = options.validate(value);
			if (
				!origin ||
				!Number.isSafeInteger(at) ||
				at < 0 ||
				validated === null
			) {
				throw new Error("invalid extension config cache entry");
			}
			return runExclusive(async () => {
				const record: PersistedConfigRecord = {
					version: 1,
					serverOrigin: origin,
					tokenFingerprint: await tokenFingerprint(token),
					at,
					value: validated,
				};
				await options.storage.set({ [PERSISTED_CONFIG_KEY]: record });
				return { serverOrigin: origin, at, value: validated };
			});
		},
		async clear(server: string, token: string): Promise<void> {
			const origin = normalizeServerOrigin(server);
			if (!origin) return;
			return runExclusive(async () => {
				const stored = (await options.storage.get(PERSISTED_CONFIG_KEY))[
					PERSISTED_CONFIG_KEY
				];
				if (stored === undefined) return;
				if (!isPersistedConfigRecord(stored)) {
					await discard();
					return;
				}
				if (
					stored.serverOrigin === origin &&
					stored.tokenFingerprint === (await tokenFingerprint(token))
				) {
					await discard();
				}
			});
		},
	};
}
