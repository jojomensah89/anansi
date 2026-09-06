/**
 * The isolated-world half, for every MAIN-world script.
 *
 * A MAIN-world script has the page's JavaScript context but no extension
 * APIs; this has extension APIs but not the page's context. Neither can do
 * the job alone, so they talk by window.postMessage and this carries the
 * result to the background worker.
 *
 * It is also the trust boundary. A MAIN-world script shares a context with
 * the site's own code, so everything arriving from it is treated as data:
 * no token, no server url and no configuration secret is ever sent into that
 * world, and nothing coming out of it is acted on beyond being forwarded.
 */
import {
  MESSAGE_PROTOCOL_VERSION,
  parseExtensionMessage,
  type PlatformSource,
} from "../lib/messages.ts";

export default defineContentScript({
  matches: [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://www.reddit.com/*",
    "https://old.reddit.com/*",
    "https://reddit.com/*",
    "https://github.com/*",
  ],
  runAt: "document_start",

  main() {
    // Correlation only. MAIN-world code can observe this value, so it is not
    // an authentication secret against code already executing in the page.
    const nonce = crypto.randomUUID();

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const parsed = parseExtensionMessage(event.data, {
        path: "page-to-relay",
        pageUrl: window.location.href,
        expectedNonce: nonce,
      });
      if (!parsed.ok) return;
      void browser.runtime.sendMessage(parsed.message).catch(() => {});
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      const incoming = message as {
        anansi?: unknown;
        action?: unknown;
        source?: unknown;
        config?: unknown;
      };
      const candidate = {
        anansi: incoming?.anansi,
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source: incoming?.source as PlatformSource,
        nonce,
        action: incoming?.action,
        config: incoming?.config,
      };
      const parsed = parseExtensionMessage(candidate, {
        path: "relay-to-page",
        pageUrl: window.location.href,
        expectedNonce: nonce,
      });
      if (parsed.ok) window.postMessage(parsed.message, window.location.origin);
      return undefined;
    });
  },
});
