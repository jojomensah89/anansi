import { isExtensionPlatformSource, type ExtensionPlatformSource } from "@anansi/sources";
import { MESSAGE_PROTOCOL_VERSION } from "./messages.ts";

/**
 * "Import everything", asked for by the library page.
 *
 * The library tab relays `library-import-request` from the page to the worker
 * as this one tiny command. The page is only trusted to name a source: it must
 * be the connected Anansi origin's top frame, the source must be a platform
 * this extension imports, and the server must have that source switched on.
 * Everything after that is the same full import the popup starts, so the two
 * entry points cannot drift apart.
 */
export interface LibraryImportCommand {
	anansi: "library-import";
	messageVersion: typeof MESSAGE_PROTOCOL_VERSION;
	source: ExtensionPlatformSource;
}

export function isLibraryImportCommand(
	message: unknown,
	senderUrl: string | undefined,
	connectedOrigin: string | undefined,
	frameId: number | undefined,
): message is LibraryImportCommand {
	if (frameId !== 0 || !senderUrl || !connectedOrigin) return false;
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const value = message as Record<string, unknown>;
	const keys = Object.keys(value);
	if (keys.length !== 3 || !["anansi", "messageVersion", "source"].every((key) => keys.includes(key))) return false;
	if (value.anansi !== "library-import" || value.messageVersion !== MESSAGE_PROTOCOL_VERSION) return false;
	if (typeof value.source !== "string" || !isExtensionPlatformSource(value.source)) return false;
	try {
		const sender = new URL(senderUrl);
		if (sender.origin !== new URL(connectedOrigin).origin) return false;
		// The library UI, never its API or MCP endpoints.
		return !sender.pathname.startsWith("/api/") && !sender.pathname.startsWith("/mcp");
	} catch {
		return false;
	}
}

export interface LibraryImportDependencies {
	/** The paired server origin, or nothing when this browser is not paired. */
	connectedOrigin(): Promise<string | undefined>;
	/**
	 * Sources the server has switched on, from the parsed extension config, or
	 * null when capture is off or the config could not be read.
	 */
	enabledSources(): Promise<readonly string[] | null>;
	/** The popup's full import for one source. Resolves when the run ends. */
	start(source: ExtensionPlatformSource): Promise<void>;
}

export async function startLibraryImport(
	message: unknown,
	sender: { url?: string; frameId?: number; fromTab: boolean },
	dependencies: LibraryImportDependencies,
): Promise<{ ok: boolean }> {
	if (!sender.fromTab) return { ok: false };
	const origin = await dependencies.connectedOrigin();
	if (!isLibraryImportCommand(message, sender.url, origin, sender.frameId)) return { ok: false };
	const enabled = await dependencies.enabledSources().catch(() => null);
	if (!enabled?.includes(message.source)) return { ok: false };
	// Answer once the run is under way, not when it finishes: a TikTok import
	// in its visible window can take minutes.
	void dependencies.start(message.source).catch(() => {});
	return { ok: true };
}
