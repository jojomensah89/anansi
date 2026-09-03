/**
 * Watches Reddit's own save action.
 *
 * This is what makes "save a post, refresh the library, it is there" work.
 * When you click Save, Reddit POSTs to /api/save; this notices and tells the
 * background worker to pull the top of your saved listing.
 *
 * It reports a signal, never the response body: /api/save answers with
 * essentially nothing, so uploading it would only teach the server that
 * something happened without saying what. Re-reading the first page of
 * saved.json is one request, reuses the path that already works, and arrives
 * with the full item.
 *
 * MAIN world at document_start, because an isolated content script's
 * window.fetch is a different object from the one Reddit's page calls.
 */
export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    let watched: string[] = [];
    const matchUrl = (url: string) => watched.some((fragment) => url.includes(fragment));

    const signal = () =>
      window.postMessage({ anansi: "saved", source: "reddit" }, window.location.origin);

    const nativeFetch = window.fetch;
    const patched = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const res = await nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        // Only on success: a failed save is not a save.
        if (matchUrl(url) && res.ok) signal();
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
        if (matchUrl(String(url))) {
          this.addEventListener("load", () => {
            if (this.status >= 200 && this.status < 300) signal();
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
      const msg = event.data as { anansi?: string; config?: { source?: string; watchUrls?: string[] } };
      if (msg?.anansi === "configure" && msg.config?.source === "reddit") {
        watched = msg.config.watchUrls ?? [];
      }
    });
  },
});
