/**
 * TikTok favourites, by observation.
 *
 * There is no backfill to write. TikTok publishes no favourites endpoint and
 * signs its web requests — X-Bogus and msToken are computed by its own
 * bundle — so nothing outside the app can forge one. What can be done is
 * watch the requests the app makes for itself while your favourites load, and
 * keep the responses.
 *
 * What has changed is that you no longer have to do the loading. This reports
 * the signed-in handle so the extension can send the tab to your own profile,
 * opens the Favourites tab, and scrolls it. Pressing Import is the whole
 * interaction; "scroll your favourites to capture them" was never an
 * instruction anyone should have been given.
 *
 * Favourites and Likes are different actions and are kept apart deliberately:
 * only the collected-item listing is a bookmark here.
 *
 * MAIN world at document_start for the same reason as x-main: patching fetch
 * after the app has cached its own reference patches nothing.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import {
  FAVOURITES_TAB_SELECTORS,
  isFavouritesRequest,
  readHandle,
  readItemList,
} from "../lib/platforms/tiktok.ts";

type Outbound =
  | { action: "observed"; operation: string; raw: unknown; items: number }
  | { action: "identified"; handle: string }
  | { action: "scanned" }
  | { action: "error"; errorCode: "capture_failed" | "not_signed_in" };

interface ScanConfig {
  source: string;
  watchUrls?: string[];
}

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
    /** Set by any observed Favourites page that said there is more. */
    let moreToLoad = true;

    /** Only pass on a Favourites payload that actually carries items. */
    const forward = (operation: string, raw: unknown) => {
      const page = readItemList(raw);
      moreToLoad = page.hasMore;
      if (page.count === 0) return;
      send({ action: "observed", operation, raw, items: page.count });
    };

    const matchUrl = (url: string) =>
      isFavouritesRequest(url, { watchUrls: watched })
        ? (watched.find((fragment) => url.includes(fragment)) ?? "favourites")
        : null;

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

    // ---- who is signed in --------------------------------------------------

    /**
     * The handle, from the blob TikTok rehydrates its app with.
     *
     * It is written into the document by the server, so at document_start it
     * may not be there yet; this waits for it rather than reporting a
     * signed-out state that is only early.
     */
    const identify = async (): Promise<string | null> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const scope =
          (window as unknown as { __UNIVERSAL_DATA_FOR_REHYDRATION__?: unknown })
            .__UNIVERSAL_DATA_FOR_REHYDRATION__ ??
          (window as unknown as { SIGI_STATE?: unknown }).SIGI_STATE;
        const handle = readHandle(scope);
        if (handle) return handle;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    // ---- the scan ----------------------------------------------------------

    const clickFavouritesTab = async (): Promise<boolean> => {
      const deadline = Date.now() + 8_000;
      for (;;) {
        for (const selector of FAVOURITES_TAB_SELECTORS) {
          const tab = document.querySelector<HTMLElement>(selector);
          if (tab) {
            tab.click();
            // Let the tab swap its list before anything scrolls it.
            await new Promise((r) => setTimeout(r, 1_200));
            return true;
          }
        }
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    /**
     * Load the rest of the list.
     *
     * TikTok fetches as the page grows, and the patch above keeps what comes
     * back, so scrolling is the whole import. It ends when a Favourites
     * response says there is no more — a real answer — and falls back to the
     * page having stopped growing, which is what "no more" looks like from out
     * here when nothing said so.
     */
    const scan = async () => {
      let stalled = 0;
      for (let step = 0; step < 400 && stalled < 4 && moreToLoad; step++) {
        const before = document.body.scrollHeight;
        window.scrollTo({ top: before, behavior: "auto" });
        await new Promise((r) => setTimeout(r, 1_200));
        stalled = document.body.scrollHeight > before ? 0 : stalled + 1;
      }
    };

    // ---- commands from the relay ------------------------------------------

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: ScanConfig;
        messageVersion?: number;
        nonce?: string;
      };
      if (
        msg?.anansi !== "page-command" ||
        msg.messageVersion !== MESSAGE_PROTOCOL_VERSION ||
        typeof msg.nonce !== "string" ||
        msg.config?.source !== "tiktok"
      ) {
        return;
      }

      if (msg.action === "configure") {
        nonce = msg.nonce;
        watched = msg.config.watchUrls ?? [];
      }

      if (msg.action === "identify" && msg.nonce === nonce) {
        void (async () => {
          const handle = await identify();
          if (handle) send({ action: "identified", handle });
          else send({ action: "error", errorCode: "not_signed_in" });
        })();
      }

      if (msg.action === "scan" && msg.nonce === nonce) {
        if (scanning) return;
        scanning = true;
        moreToLoad = true;
        void (async () => {
          await clickFavouritesTab();
          await scan();
          scanning = false;
          send({ action: "scanned" });
        })();
      }
    });
  },
});
