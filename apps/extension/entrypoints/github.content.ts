import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import { extractGitHubStarsPage } from "../lib/platforms/github.ts";

interface GitHubConfig {
	source: "github";
	pageLimit?: number;
	page?: number;
}

export default defineContentScript({
	matches: ["https://github.com/*"],
	runAt: "document_idle",

	main() {
		let nonce: string | null = null;

		const send = (action: string, payload: Record<string, unknown> = {}) => {
			if (!nonce) return;
			window.postMessage(
				{
					anansi: "page-event",
					messageVersion: MESSAGE_PROTOCOL_VERSION,
					source: "github",
					nonce,
					action,
					...payload,
				},
				window.location.origin,
			);
		};

		const backfill = (config: GitHubConfig) => {
			const result = extractGitHubStarsPage(document, window.location.href);
			if (result.kind === "signed_out") {
				send("error", { errorCode: "not_signed_in" });
				return;
			}
			if (result.kind === "page_shape_changed") {
				send("error", { errorCode: "page_shape_changed" });
				return;
			}

			const page = Math.max(1, Math.floor(config.page ?? 1));
			if (result.kind === "empty") {
				send("done", { pages: page - 1, items: 0 });
				return;
			}

			send("page", {
				raw: result.page,
				page,
				items: result.page.repositories.length,
				...(result.page.nextUrl ? { cursor: result.page.nextUrl } : {}),
			});
			if (!result.page.nextUrl || page >= (config.pageLimit ?? 40)) {
				send("done", { pages: page, items: result.page.repositories.length });
			}
		};

		window.addEventListener("message", (event) => {
			if (event.source !== window || event.origin !== window.location.origin)
				return;
			const message = event.data as {
				anansi?: string;
				action?: string;
				config?: GitHubConfig;
				messageVersion?: number;
				nonce?: string;
			};
			if (
				message?.anansi !== "page-command" ||
				message.messageVersion !== MESSAGE_PROTOCOL_VERSION ||
				typeof message.nonce !== "string" ||
				message.config?.source !== "github"
			) {
				return;
			}
			nonce = message.nonce;
			if (message.action === "backfill") backfill(message.config);
		});
	},
});
