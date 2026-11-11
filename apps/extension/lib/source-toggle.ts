import { isToggleableSource } from "@anansi/sources";

/**
 * The popup's capture switch, sent from the worker with the stored key.
 *
 * The same switch as the library's Sources page: the server records it, and a
 * source switched off drops out of the config every capture path reads.
 */
export type SourceToggleResult =
	| { ok: true; source: string; enabled: boolean }
	| { ok: false; error: string };

export async function requestSourceToggle(
	connection: { server: string; token: string },
	source: string,
	enabled: boolean,
	transport: typeof fetch = fetch,
): Promise<SourceToggleResult> {
	if (!isToggleableSource(source)) return { ok: false, error: "This source is always on" };
	let response: Response;
	try {
		response = await transport(`${connection.server}/api/extension/sources/${encodeURIComponent(source)}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
			body: JSON.stringify({ enabled }),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { ok: false, error: "Could not reach the library" };
	}
	if (response.status === 401 || response.status === 403) return { ok: false, error: "Key rejected" };
	if (!response.ok) return { ok: false, error: `The library answered with HTTP ${response.status}` };
	const body = (await response.json().catch(() => null)) as { source?: unknown; enabled?: unknown } | null;
	// Only a reply that names this exact change counts. Anything else could be a
	// proxy page or an older server, and the switch must not claim it worked.
	if (body?.source !== source || body.enabled !== enabled)
		return { ok: false, error: "Unexpected reply from the library" };
	return { ok: true, source, enabled };
}
