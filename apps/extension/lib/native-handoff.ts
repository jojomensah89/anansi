import type { PlatformSource } from "./messages.ts";
import { MESSAGE_PROTOCOL_VERSION } from "./messages.ts";

const MAX_HANDOFF_MESSAGE_BYTES = 1_050_000;

export interface NativeHandoffStoreRequest {
	anansi: "native-handoff";
	action: "store";
	messageVersion: typeof MESSAGE_PROTOCOL_VERSION;
	message: unknown;
}

/** Validate the small relay envelope before validating its page event and sender. */
export function parseNativeHandoffStoreRequest(
	value: unknown,
): NativeHandoffStoreRequest | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	) return null;
	if (
		Object.keys(candidate).length !== 4 ||
		candidate.anansi !== "native-handoff" ||
		candidate.action !== "store" ||
		candidate.messageVersion !== MESSAGE_PROTOCOL_VERSION ||
		!("message" in candidate)
	) return null;
	let bytes: number;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return null;
	}
	if (bytes > MAX_HANDOFF_MESSAGE_BYTES) return null;
	return candidate as unknown as NativeHandoffStoreRequest;
}

/** A key is derived from validated event identity; the relay cannot name storage. */
export function nativeHandoffStorageKey(
	source: PlatformSource,
	mutationId: string,
): string | null {
	if (!/^[A-Za-z0-9:_-]{1,200}$/.test(mutationId)) return null;
	return `native-handoff:${source}:${mutationId}`;
}
