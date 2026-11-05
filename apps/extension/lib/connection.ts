import { normalizeServerOrigin } from "./config-cache.ts";

export interface ExtensionConnection {
	readonly origin: string;
	readonly token: string;
}

export type ExtensionBuildMode = "public" | "private";

const CONNECTION_KEY = "anansiConnection";
const DISCONNECTED_KEY = "anansiConnectionExplicitlyDisconnected";

export interface ExtensionConnectionStorage {
	get(keys: string | string[]): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
	setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

/**
 * Validate a connection entered at runtime or supplied to an explicit private
 * build. Error messages identify the setting, never its value.
 */
export function validateExtensionConnection(
	originValue: unknown,
	tokenValue: unknown,
): ExtensionConnection {
	const origin =
		typeof originValue === "string" ? normalizeServerOrigin(originValue) : null;
	if (!origin) {
		throw new Error(
			"Server origin must be an HTTPS origin (or loopback HTTP for local development)",
		);
	}

	const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
	if (token.length < 16) {
		throw new Error("Ingest token must contain at least 16 characters");
	}

	return Object.freeze({ origin, token });
}

export function resolveExtensionBuildMode(value: unknown): ExtensionBuildMode {
	if (value === undefined || value === "" || value === "public") return "public";
	if (value === "private") return "private";
	throw new Error("ANANSI_EXTENSION_BUILD_MODE must be public or private");
}

/**
 * Public output is always unconfigured, even when the repository .env contains
 * a private deployment. Private output is available only through an explicit
 * build mode. WXT's prepare command stays credential-free when no connection
 * has been explicitly supplied.
 */
export function connectionForWxtConfig(
	originValue: unknown,
	tokenValue: unknown,
	command: unknown,
	modeValue: unknown = "public",
): ExtensionConnection | null {
	const mode = resolveExtensionBuildMode(modeValue);
	if (mode === "public") return null;

	if (typeof command === "string" && command.toLowerCase() === "prepare") {
		try {
			return validateExtensionConnection(originValue, tokenValue);
		} catch {
			return null;
		}
	}
	return validateExtensionConnection(originValue, tokenValue);
}

function privateBuildConnection(): ExtensionConnection | null {
	try {
		if (
			typeof __ANANSI_EXTENSION_ORIGIN__ === "undefined" ||
			typeof __ANANSI_EXTENSION_INGEST_TOKEN__ === "undefined" ||
			!__ANANSI_EXTENSION_ORIGIN__ ||
			!__ANANSI_EXTENSION_INGEST_TOKEN__
		) {
			return null;
		}
		return validateExtensionConnection(
			__ANANSI_EXTENSION_ORIGIN__,
			__ANANSI_EXTENSION_INGEST_TOKEN__,
		);
	} catch {
		return null;
	}
}

/**
 * Restrict local storage to trusted extension contexts where the browser
 * exposes that control. Popup and service-worker contexts remain authorized;
 * content scripts cannot read the stored ingest token in Chrome.
 */
export function createExtensionConnectionStore(
	storage: ExtensionConnectionStorage,
	fallback: () => ExtensionConnection | null = privateBuildConnection,
) {
	let accessLevelSetup: Promise<void> | undefined;
	const restrictStorage = async (): Promise<void> => {
		if (!storage.setAccessLevel) return;
		accessLevelSetup ??= storage.setAccessLevel({
			accessLevel: "TRUSTED_CONTEXTS",
		});
		await accessLevelSetup;
	};

	return {
		async get(): Promise<ExtensionConnection | null> {
			await restrictStorage();
			const stored = await storage.get([CONNECTION_KEY, DISCONNECTED_KEY]);
			if (stored[DISCONNECTED_KEY] === true) return null;

			const value = stored[CONNECTION_KEY];
			if (value !== undefined) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					return null;
				}
				const record = value as Record<string, unknown>;
				try {
					return validateExtensionConnection(record.origin, record.token);
				} catch {
					return null;
				}
			}
			return fallback();
		},

		async save(
			originValue: string,
			tokenValue: string,
		): Promise<ExtensionConnection> {
			const connection = validateExtensionConnection(originValue, tokenValue);
			await restrictStorage();
			// Write credentials first, then re-enable retrieval. An interrupted save
			// remains disconnected instead of restoring a private build fallback.
			await storage.set({ [CONNECTION_KEY]: connection });
			await storage.remove(DISCONNECTED_KEY);
			return connection;
		},

		async clear(): Promise<void> {
			await restrictStorage();
			// The marker is durable before the credential is removed, so a private
			// build cannot silently reconnect if removal is interrupted.
			await storage.set({ [DISCONNECTED_KEY]: true });
			await storage.remove(CONNECTION_KEY);
		},
	};
}

function browserConnectionStore() {
	if (typeof browser === "undefined" || !browser.storage?.local) return null;
	return createExtensionConnectionStore(browser.storage.local);
}

export async function getExtensionConnection(): Promise<ExtensionConnection | null> {
	const store = browserConnectionStore();
	if (!store) return privateBuildConnection();
	try {
		return await store.get();
	} catch {
		// Fail closed when storage is unavailable or access could not be restricted.
		return null;
	}
}

export async function saveExtensionConnection(
	originValue: string,
	tokenValue: string,
): Promise<ExtensionConnection> {
	const store = browserConnectionStore();
	if (!store) {
		throw new Error("Extension storage is unavailable");
	}
	return store.save(originValue, tokenValue);
}

export async function clearExtensionConnection(): Promise<void> {
	const store = browserConnectionStore();
	if (!store) return;
	await store.clear();
}
