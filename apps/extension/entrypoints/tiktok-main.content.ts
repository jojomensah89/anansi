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

type Outbound =
  | { anansi: "observed"; source: "tiktok"; operation: string; raw: unknown; items: number }
  | { anansi: "error"; source: "tiktok"; message: string };

export default defineContentScript({
  matches: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    const send = (msg: Outbound) => window.postMessage(msg, window.location.origin);

    let watched: string[] = [];
    const matchUrl = (url: string) => watched.find((fragment) => url.includes(fragment));

    /** Only pass on a payload that actually carries items. */
    const forward = (operation: string, raw: unknown) => {
      const list = (raw as { itemList?: unknown[]; items?: unknown[] })?.itemList
        ?? (raw as { items?: unknown[] })?.items;
      if (!Array.isArray(list) || list.length === 0) return;
      send({ anansi: "observed", source: "tiktok", operation, raw, items: list.length });
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
      const msg = event.data as { anansi?: string; config?: { watchUrls?: string[]; source?: string } };
      if (msg?.anansi === "configure" && msg.config?.source === "tiktok") {
        watched = msg.config.watchUrls ?? [];
      }
      if (msg?.anansi === "backfill" && msg.config?.source === "tiktok") {
        send({
          anansi: "error",
          source: "tiktok",
          message: "TikTok has no history endpoint — open your Favourites and scroll; saves are captured as they load.",
        });
      }
    });
  },
});
