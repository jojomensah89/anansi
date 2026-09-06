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

/** Immutable connection compiled into this private extension artifact. */
export function extensionConnection(): ExtensionConnection {
	return validateExtensionConnection(
		__ANANSI_EXTENSION_ORIGIN__,
		__ANANSI_EXTENSION_INGEST_TOKEN__,
	);
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
