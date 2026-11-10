/**
 * The page side of the extension bridge.
 *
 * The extension's content script listens on this page's own window for
 * `{ anansi: "<name>-request", id, ... }` and answers with
 * `{ anansi: "<name>-response", id, ok }`. Anything else on the channel,
 * another id, another origin or another window, is ignored. No answer
 * before the timeout means the extension is not there, so the call
 * resolves false rather than hanging.
 */
type BridgeName = "library-sync" | "library-import" | "library-connect";

export function bridgeRequest(
	name: BridgeName,
	payload: Record<string, unknown> = {},
	timeoutMs = 3000,
): Promise<boolean> {
	if (typeof window === "undefined") return Promise.resolve(false);
	return new Promise((resolve) => {
		const id = crypto.randomUUID();
		const done = (ok: boolean) => {
			clearTimeout(timer);
			window.removeEventListener("message", receive);
			resolve(ok);
		};
		const receive = (event: MessageEvent) => {
			if (
				event.source === window &&
				event.origin === location.origin &&
				event.data?.anansi === `${name}-response` &&
				event.data.id === id
			)
				done(event.data.ok === true);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		window.addEventListener("message", receive);
		window.postMessage({ ...payload, anansi: `${name}-request`, id }, location.origin);
	});
}

/** Ask the extension to import a source's full history. False: open the popup instead. */
export function requestExtensionImport(source: string): Promise<boolean> {
	return bridgeRequest("library-import", { source }, 3000);
}

/** Ask the extension to check every source now. */
export function requestExtensionSync(): Promise<boolean> {
	return bridgeRequest("library-sync", {}, 2000);
}

/** Hand a pairing code to the extension so the user need not paste it. */
export function requestExtensionConnect(code: string): Promise<boolean> {
	return bridgeRequest("library-connect", { code }, 3000);
}
