import { createNativeSnapshotCache } from "../lib/native-snapshot.ts";
import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import type { NormalizedItem } from "@anansi/sources";
import {
	createNativeTransitionOrder,
	type NativeTransitionConfirmation,
} from "../lib/native-transition-order.ts";
import {
	readGitHubStarMutation,
	type GitHubStarMutation,
} from "../lib/platforms/github.ts";

export default defineContentScript({
	matches: ["https://github.com/*"],
	world: "MAIN",
	runAt: "document_start",

	main() {
		const snapshots = createNativeSnapshotCache("github");
		const waiting: Array<() => void> = [];
		const transitions = createNativeTransitionOrder();
		let nonce: string | null = null;
		const sendSaved = () => {
			const post = () =>
				window.postMessage(
					{
						anansi: "page-event",
						messageVersion: MESSAGE_PROTOCOL_VERSION,
						source: "github",
						nonce,
						action: "saved",
					},
					window.location.origin,
				);
			if (!nonce) {
				if (waiting.length < 100) waiting.push(post);
				return;
			}
			post();
		};
		const snapshotFor = (id: string): NormalizedItem | undefined => {
			try {
				return snapshots.get(id);
			} catch {
				return undefined;
			}
		};

		type MutationCapture = {
			mutation: GitHubStarMutation;
			identity: { mutationId: string; observedAt: number };
			startingItem?: NormalizedItem;
			transition: NativeTransitionConfirmation;
			recoverySent: boolean;
		};
		const recoverMutation = (capture: MutationCapture, force = false) => {
			if (capture.recoverySent && !force) return;
			capture.recoverySent = true;
			sendSaved();
		};
		const captureMutation = (
			url: string,
			method: string,
		): MutationCapture | null => {
			let mutation: GitHubStarMutation | null;
			try {
				mutation = readGitHubStarMutation(url, method, true);
			} catch {
				return null;
			}
			if (!mutation) return null;
			const reservation = transitions.reserve();
			const startingItem =
				mutation.action === "save"
					? snapshotFor(mutation.externalId)
					: undefined;
			const transition = reservation.bind(mutation.externalId);
			if (!transition) return null;
			const capture = {
				mutation,
				identity: {
					mutationId: crypto.randomUUID(),
					observedAt: Math.floor(Date.now() / 1000),
				},
				...(startingItem ? { startingItem } : {}),
				transition,
				recoverySent: false,
			};
			void transition.timedOut.then((timedOut) => {
				if (timedOut) recoverMutation(capture);
			});
			return capture;
		};
		const sendMutation = (
			capture: MutationCapture,
			item: NormalizedItem | undefined,
		) => {
			const { mutation, identity } = capture;
			const post = () =>
				window.postMessage(
					{
						anansi: "page-event",
						messageVersion: MESSAGE_PROTOCOL_VERSION,
						source: "github",
						nonce,
						action: "bookmark",
						bookmarkAction: mutation.action,
						externalId: mutation.externalId,
						canonicalUrl: item?.url ?? mutation.canonicalUrl,
						...identity,
						...(item ? { normalizedItem: item } : {}),
					},
					window.location.origin,
				);
			if (!nonce) {
				if (waiting.length < 100) waiting.push(post);
				return;
			}
			post();
		};
		const noteMutation = (capture: MutationCapture | null, ok: boolean) => {
			if (!capture) return;
			if (!ok) {
				capture.transition.fail();
				return;
			}
			const item =
				capture.mutation.action === "save"
					? capture.startingItem ?? snapshotFor(capture.mutation.externalId)
					: undefined;
			if (!capture.transition.confirm(() => sendMutation(capture, item))) {
				recoverMutation(capture, true);
			}
		};

		const nativeFetch = window.fetch;
		const patchedFetch = async function (
			this: unknown,
			...args: Parameters<typeof fetch>
		) {
			const input = args[0];
			let url = "";
			let method = "GET";
			try {
				url =
					typeof input === "string"
						? input
						: input instanceof Request
							? input.url
							: String(input);
			} catch {
				// The native fetch still receives the original arguments below.
			}
			try {
				method =
					args[1]?.method ?? (input instanceof Request ? input.method : "GET");
			} catch {
				// Method inspection must not preempt the native request.
			}
			const capture = captureMutation(url, method);
			let responsePromise: Promise<Response>;
			try {
				responsePromise = nativeFetch.apply(this, args);
			} catch (error) {
				capture?.transition.fail();
				throw error;
			}
			let response: Response;
			try {
				response = await responsePromise;
			} catch (error) {
				capture?.transition.fail();
				throw error;
			}
			try {
				noteMutation(capture, response.ok);
			} catch {
				capture?.transition.fail();
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
			try {
				this.__anansiMethod = method;
				this.__anansiUrl = String(url);
			} catch {
				// Forward the original arguments even if observation cannot inspect them.
			}
			// @ts-expect-error forwarding the browser's original overload
			return nativeOpen.call(this, method, url, ...rest);
		};
		const nativeSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function (
			this: WatchedXhr,
			body?: Document | XMLHttpRequestBodyInit | null,
		) {
			const capture = captureMutation(
				this.__anansiUrl ?? "",
				this.__anansiMethod ?? "GET",
			);
			if (capture) {
				try {
					this.addEventListener(
						"load",
						() => noteMutation(capture, this.status >= 200 && this.status < 300),
						{ once: true },
					);
					for (const eventName of ["error", "abort", "timeout"] as const) {
						this.addEventListener(eventName, () => capture.transition.fail(), {
							once: true,
						});
					}
				} catch {
					capture.transition.fail();
				}
			}
			try {
				return nativeSend.call(this, body ?? null);
			} catch (error) {
				capture?.transition.fail();
				throw error;
			}
		};

		// Turbo submits through fetch; observing submit-end too double-counts it.

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
				for (const send of waiting.splice(0)) send();
			}
		});
	},
});
