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
export default defineContentScript({
  matches: [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://www.tiktok.com/*",
    "https://tiktok.com/*",
    "https://www.reddit.com/*",
    "https://old.reddit.com/*",
    "https://reddit.com/*",
  ],
  runAt: "document_start",

  main() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as { anansi?: string } | undefined;
      // Commands travel the other way; do not echo them back.
      if (!msg?.anansi || ["configure", "backfill", "scan"].includes(msg.anansi)) return;
      void browser.runtime.sendMessage(msg).catch(() => {});
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as { anansi?: string } | undefined;
      if (msg?.anansi && ["configure", "backfill", "scan"].includes(msg.anansi)) {
        window.postMessage(msg, window.location.origin);
      }
      return undefined;
    });
  },
});
