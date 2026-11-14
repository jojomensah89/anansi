/**
 * Injected into open library tabs by `scripting.executeScript`.
 *
 * It is serialized and run in the tab's isolated world, so it must not close
 * over anything in this module: only `window`, `location` and `chrome` exist
 * where it runs. The page can ask for three things (sync now, connect with a
 * code, import one source's history) and gets back only `{ id, ok }`.
 */
export function libraryBridgeScript(): void {
	const marker = "__anansiSyncBridge";
	// `chrome` is typed here, not taken from @types/chrome, so this file needs no global typings.
	const state = globalThis as typeof globalThis & {
		__anansiSyncBridge?: (event: MessageEvent) => void;
		chrome: { runtime: { sendMessage(message: unknown): Promise<{ ok?: unknown } | undefined> } };
	};
	if (state[marker]) window.removeEventListener("message", state[marker]);
	state[marker] = (event) => {
		const data = event.data as Record<string, unknown> | null | undefined;
		if (
			event.source !== window ||
			event.origin !== location.origin ||
			typeof data?.anansi !== "string" ||
			!["library-sync-request", "library-connect-request", "library-import-request"].includes(data.anansi) ||
			typeof data.id !== "string" ||
			data.id.length > 80
		)
			return;
		const id = data.id;
		const kind = data.anansi;
		const family =
			kind === "library-connect-request"
				? "library-connect-response"
				: kind === "library-import-request"
					? "library-import-response"
					: "library-sync-response";
		const reply = (ok: boolean) => window.postMessage({ anansi: family, id, ok }, location.origin);
		// Only a short string crosses; the worker decides whether it names a real source.
		if (kind === "library-import-request" && (typeof data.source !== "string" || data.source.length > 32)) {
			reply(false);
			return;
		}
		const request =
			kind === "library-connect-request"
				? { anansi: "library-connect", messageVersion: 1, code: data.code }
				: kind === "library-import-request"
					? { anansi: "library-import", messageVersion: 1, source: data.source }
					: { anansi: "library-sync-now", messageVersion: 1 };
		void state.chrome.runtime
			.sendMessage(request)
			.then((result: { ok?: unknown } | undefined) => reply(result?.ok === true))
			.catch(() => reply(false));
	};
	window.addEventListener("message", state[marker]);
}
