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
import { createRelayHandshake } from "../lib/relay-handshake.ts";
import { captureSourceFromUrl } from "../lib/platforms/registry.ts";
import { createSaveToast, deliverWithConfirmation, rejectedSaveAction } from "../lib/save-toast.ts";

export default defineContentScript({
  matches: [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://www.reddit.com/*",
    "https://old.reddit.com/*",
    "https://reddit.com/*",
    "https://github.com/*",
    "https://www.tiktok.com/*",
    "https://tiktok.com/*",
  ],
  runAt: "document_start",

  main() {
    // Correlation only. MAIN-world code can observe this value, so it is not
    // an authentication secret against code already executing in the page.
    const nonce = crypto.randomUUID();
    const handshake = createRelayHandshake((message: unknown) =>
      window.postMessage(message, window.location.origin));
    document.addEventListener("DOMContentLoaded", () => handshake.documentReady(), { once: true });

    const saveToast = createSaveToast({
      document,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      schedule: (run, ms) => window.setTimeout(run, ms),
      cancel: (id) => window.clearTimeout(id),
    });
    // Remember where the person clicked, so the confirmation appears beside
    // the platform's own button. The event's target is never read.
    window.addEventListener(
      "pointerdown",
      (event) => saveToast.notePointer(event.clientX, event.clientY),
      { capture: true, passive: true },
    );

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const parsed = parseExtensionMessage(event.data, {
        path: "page-to-relay",
        pageUrl: window.location.href,
        expectedNonce: nonce,
      });
      if (!parsed.ok) {
        const rejected = rejectedSaveAction(event.data, nonce);
        if (rejected) saveToast.show(rejected, "failed");
        return;
      }
      if (parsed.message.action === "bookmark") {
        // The trusted worker owns durable storage. It acknowledges only after
        // the handoff is persisted or has reached the durable native outbox.
        const message = { ...parsed.message, mutationId: parsed.message.mutationId ?? crypto.randomUUID() };
        void deliverWithConfirmation({
          send: () =>
            browser.runtime.sendMessage({
              anansi: "native-handoff",
              action: "store",
              messageVersion: MESSAGE_PROTOCOL_VERSION,
              message,
            }),
          notify: (outcome) => saveToast.show(message.bookmarkAction, outcome),
          retryLater: (again) => void setTimeout(again, 2_000),
        });
      } else void browser.runtime.sendMessage(parsed.message).catch(() => {});
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      const incoming = message as {
        anansi?: unknown;
        action?: unknown;
        source?: unknown;
        runId?: unknown;
        config?: unknown;
      };
      const candidate = {
        anansi: incoming?.anansi,
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source: incoming?.source as PlatformSource,
        nonce,
        action: incoming?.action,
        ...(typeof incoming?.runId === "string" ? { runId: incoming.runId } : {}),
        config: incoming?.config,
      };
      const parsed = parseExtensionMessage(candidate, {
        path: "relay-to-page",
        pageUrl: window.location.href,
        expectedNonce: nonce,
      });
      if (parsed.ok) {
        if (parsed.message.action === "configure") handshake.configure(parsed.message);
        else window.postMessage(parsed.message, window.location.origin);
      }
      return undefined;
    });

    // The page script starts with no nonce or watched operations. Ask the
    // background for its current source config as soon as this relay loads;
    // an already-open SPA tab may never get another tabs.onUpdated event.
    const source = captureSourceFromUrl(window.location.href);
    if (!source) return;
    const announce = () =>
      void browser.runtime.sendMessage({
        anansi: "page-event",
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source,
        nonce,
        action: "ready",
        queryId: null,
        relay: true,
      }).catch(() => {});
    announce();
    // A page restored from history resumes with this relay and its old nonce.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) announce();
    });
  },
});
