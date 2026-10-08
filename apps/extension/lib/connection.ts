import { normalizeServerOrigin } from "./config-cache.ts";

export interface ExtensionConnection {
	readonly origin: string;
	readonly token: string;
}

/**
 * Validate the two values embedded into a private extension build.
 *
 * Error messages identify the setting, never its value: this function runs
 * during the build too, where an exception may end up in CI or terminal logs.
 */
export function validateExtensionConnection(
	originValue: unknown,
	tokenValue: unknown,
): ExtensionConnection {
	const origin =
		typeof originValue === "string" ? normalizeServerOrigin(originValue) : null;
	if (!origin) {
		throw new Error(
			"ANANSI_EXTENSION_ORIGIN must be an HTTPS origin (or loopback HTTP for local development)",
		);
	}

	const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
	if (token.length < 16) {
		throw new Error(
			"ANANSI_EXTENSION_INGEST_TOKEN must be set to the deployed INGEST_TOKEN",
		);
	}

	return Object.freeze({ origin, token });
}

export async function getExtensionConnection(): Promise<ExtensionConnection | null> {
	try {
		if (typeof browser !== "undefined" && browser.storage?.local) {
			const stored = await browser.storage.local.get("anansiConnection");
			const conn = (stored as { anansiConnection?: unknown })?.anansiConnection as { origin?: unknown; token?: unknown } | undefined;
			if (conn && typeof conn.origin === "string" && typeof conn.token === "string") {
				return validateExtensionConnection(conn.origin, conn.token);
			}
		}
	} catch {
		// Storage unavailable or unparseable
	}

	try {
		if (
			typeof __ANANSI_EXTENSION_ORIGIN__ !== "undefined" &&
			typeof __ANANSI_EXTENSION_INGEST_TOKEN__ !== "undefined" &&
			__ANANSI_EXTENSION_ORIGIN__ &&
			__ANANSI_EXTENSION_INGEST_TOKEN__
		) {
			return validateExtensionConnection(
				__ANANSI_EXTENSION_ORIGIN__,
				__ANANSI_EXTENSION_INGEST_TOKEN__,
			);
		}
	} catch {
		// Build-time placeholders
	}

	return null;
}

export async function saveExtensionConnection(
	originValue: string,
	tokenValue: string,
): Promise<ExtensionConnection> {
	const conn = validateExtensionConnection(originValue, tokenValue);
	if (typeof browser !== "undefined" && browser.storage?.local) {
		await browser.storage.local.set({ anansiConnection: conn });
	}
	return conn;
}

export async function clearExtensionConnection(): Promise<void> {
	if (typeof browser !== "undefined" && browser.storage?.local) {
		await browser.storage.local.remove("anansiConnection");
	}
}

/** Immutable connection compiled into this private extension artifact, or fallback. */
export function extensionConnection(): ExtensionConnection {
	try {
		return validateExtensionConnection(
			__ANANSI_EXTENSION_ORIGIN__,
			__ANANSI_EXTENSION_INGEST_TOKEN__,
		);
	} catch {
		return Object.freeze({
			origin: "http://127.0.0.1:3001",
			token: "unconfigured-placeholder-token",
		});
	}
}

const PREPARE_CONNECTION: ExtensionConnection = Object.freeze({
	origin: "http://127.0.0.1",
	token: "prepare-only-placeholder",
});

/**
 * WXT imports its config during dependency installation to generate types.
 * That command emits no installable artifact, so it may use inert placeholders;
 * every dev/build/zip command still requires the real private connection.
 */
export function connectionForWxtConfig(
	originValue: unknown,
	tokenValue: unknown,
	command: unknown,
): ExtensionConnection {
	if (typeof command === "string" && command.toLowerCase() === "prepare") {
		try {
			return validateExtensionConnection(originValue, tokenValue);
		} catch {
			return PREPARE_CONNECTION;
		}
	}
	return validateExtensionConnection(originValue, tokenValue);
}
