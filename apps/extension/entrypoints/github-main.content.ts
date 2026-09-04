import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import { readGitHubStarMutation } from "../lib/platforms/github.ts";

export default defineContentScript({
	matches: ["https://github.com/*"],
	world: "MAIN",
	runAt: "document_start",

	main() {
		let nonce: string | null = null;
		const recentlySent = new Map<string, number>();

		const noteMutation = (url: string, method: string, ok: boolean) => {
			const mutation = readGitHubStarMutation(url, method, ok);
			if (!mutation || !nonce) return;
			const key = `${mutation.action}:${mutation.externalId}`;
			const now = Date.now();
			if (now - (recentlySent.get(key) ?? 0) < 2_000) return;
			recentlySent.set(key, now);
			window.postMessage(
				{
					anansi: "page-event",
					messageVersion: MESSAGE_PROTOCOL_VERSION,
					source: "github",
					nonce,
					action: "bookmark",
					bookmarkAction: mutation.action,
					externalId: mutation.externalId,
					canonicalUrl: mutation.canonicalUrl,
				},
				window.location.origin,
			);
		};

		const nativeFetch = window.fetch;
		const patchedFetch = async function (
			this: unknown,
			...args: Parameters<typeof fetch>
		) {
			const response = await nativeFetch.apply(this, args);
			try {
				const input = args[0];
				const url =
					typeof input === "string"
						? input
						: input instanceof Request
							? input.url
							: String(input);
				const method =
					args[1]?.method ?? (input instanceof Request ? input.method : "GET");
				noteMutation(url, method, response.ok);
			} catch {
				// Observation must never break GitHub.
			}
			return response;
		};
		window.fetch = Object.assign(patchedFetch, nativeFetch) as typeof fetch;

		type WatchedXhr = XMLHttpRequest & {
			__anansiMethod?: string;
			__anansiUrl?: string;
		};
		const nativeOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (
			this: WatchedXhr,
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			this.__anansiMethod = method;
			this.__anansiUrl = String(url);
			// @ts-expect-error forwarding the browser's original overload
			return nativeOpen.call(this, method, url, ...rest);
		};
		const nativeSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function (
			this: WatchedXhr,
			body?: Document | XMLHttpRequestBodyInit | null,
		) {
			this.addEventListener("load", () => {
				noteMutation(
					this.__anansiUrl ?? "",
					this.__anansiMethod ?? "GET",
					this.status >= 200 && this.status < 300,
				);
			});
			return nativeSend.call(this, body ?? null);
		};

		document.addEventListener("turbo:submit-end", (event) => {
			try {
				const form = event.target;
				if (!(form instanceof HTMLFormElement)) return;
				const detail = (
					event as CustomEvent<{ fetchResponse?: { response?: Response } }>
				).detail;
				noteMutation(
					form.action,
					form.method,
					detail?.fetchResponse?.response?.ok === true,
				);
			} catch {
				// Observation must never break GitHub.
			}
		});

		window.addEventListener("message", (event) => {
			if (event.source !== window || event.origin !== window.location.origin)
				return;
			const message = event.data as {
				anansi?: string;
				action?: string;
				config?: { source?: string };
				messageVersion?: number;
				nonce?: string;
			};
			if (
				message?.anansi === "page-command" &&
				message.action === "configure" &&
				message.messageVersion === MESSAGE_PROTOCOL_VERSION &&
				typeof message.nonce === "string" &&
				message.config?.source === "github"
			) {
				nonce = message.nonce;
			}
		});
	},
});
