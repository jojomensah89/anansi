/**
 * TikTok favourites, by observation.
 *
 * There is no backfill to write. TikTok publishes no favourites endpoint and
 * signs its web requests — X-Bogus and msToken are computed by its own
 * bundle — so nothing outside the app can forge one. What can be done is
 * watch the requests the app makes for itself while you scroll your
 * favourites, and keep the responses.
 *
 * That is the whole capture strategy, and it has an honest consequence worth
 * saying out loud in the UI: your history arrives the first time you scroll
 * it, not at the press of a button.
 *
 * MAIN world at document_start for the same reason as x-main: patching fetch
 * after the app has cached its own reference patches nothing.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";

type Outbound =
  | { action: "observed"; operation: string; raw: unknown; items: number }
  | { action: "scanned" }
  | { action: "error"; errorCode: "capture_failed" };

export default defineContentScript({
  matches: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    let nonce: string | null = null;
    const send = (msg: Outbound) => {
      if (!nonce) return;
      window.postMessage(
        {
          ...msg,
          anansi: "page-event",
          messageVersion: MESSAGE_PROTOCOL_VERSION,
          source: "tiktok",
          nonce,
        },
        window.location.origin,
      );
    };

    let watched: string[] = [];
    let scanning = false;
    const matchUrl = (url: string) => watched.find((fragment) => url.includes(fragment));

    /** Only pass on a payload that actually carries items. */
    const forward = (operation: string, raw: unknown) => {
      const list = (raw as { itemList?: unknown[]; items?: unknown[] })?.itemList
        ?? (raw as { items?: unknown[] })?.items;
      if (!Array.isArray(list) || list.length === 0) return;
      send({ action: "observed", operation, raw, items: list.length });
    };

    const nativeFetch = window.fetch;
    const patched = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const res = await nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const operation = matchUrl(url);
        if (operation) {
          res.clone().json().then((raw) => forward(operation, raw)).catch(() => {});
        }
      } catch {
        // Observation must never break the page.
      }
      return res;
    };
    window.fetch = Object.assign(patched, nativeFetch) as typeof fetch;

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        const operation = matchUrl(String(url));
        if (operation) {
          this.addEventListener("load", () => {
            try {
              forward(operation, JSON.parse(this.responseText));
            } catch {
              /* not json, not ours */
            }
          });
        }
      } catch {
        /* never break the page */
      }
      // @ts-expect-error forwarding the original signature verbatim
      return nativeOpen.call(this, method, url, ...rest);
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: { watchUrls?: string[]; source?: string };
        messageVersion?: number;
        nonce?: string;
      };
      if (
        msg?.anansi === "page-command" &&
        msg.action === "configure" &&
        msg.messageVersion === MESSAGE_PROTOCOL_VERSION &&
        typeof msg.nonce === "string" &&
        msg.config?.source === "tiktok"
      ) {
        nonce = msg.nonce;
        watched = msg.config.watchUrls ?? [];
      }
      /**
       * The scan.
       *
       * There is no request to make, so capture is a scroll: TikTok fetches
       * its own item lists as the page grows, and the fetch patch above keeps
       * what comes back. Scrolling on your behalf is the whole import.
       *
       * It stops when the page stops growing twice in a row, which is what
       * "no more to load" looks like from out here.
       */
      if (
        msg?.anansi === "page-command" &&
        msg.action === "scan" &&
        msg.messageVersion === MESSAGE_PROTOCOL_VERSION &&
        msg.nonce === nonce &&
        msg.config?.source === "tiktok"
      ) {
        if (scanning) return;
        scanning = true;
        void (async () => {
          let stalled = 0;
          for (let step = 0; step < 60 && stalled < 3; step++) {
            const before = document.body.scrollHeight;
            window.scrollTo({ top: before, behavior: "auto" });
            await new Promise((r) => setTimeout(r, 1200));
            stalled = document.body.scrollHeight > before ? 0 : stalled + 1;
          }
          scanning = false;
          send({ action: "scanned" });
        })();
      }
    });
  },
});
