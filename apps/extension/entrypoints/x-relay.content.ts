/**
 * The isolated-world half.
 *
 * The MAIN world script has X's context but no extension APIs; this has
 * extension APIs but not X's context. Neither can do the job alone, so they
 * talk by window.postMessage and this one carries the result to the
 * background worker.
 *
 * It is also the trust boundary: the MAIN world shares a context with x.com's
 * own code, so everything arriving from it is treated as data. No token, no
 * server URL and no configuration secret is ever sent into that world.
 */
export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_start",
  main() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as { anansi?: string } | undefined;
      if (!msg?.anansi || msg.anansi === "configure" || msg.anansi === "backfill") return;
      // Fire and forget: the page must not wait on the network.
      void browser.runtime.sendMessage(msg).catch(() => {});
    });

    // Commands travel the other way: popup -> background -> here -> MAIN.
    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as { anansi?: string } | undefined;
      if (msg?.anansi === "configure" || msg?.anansi === "backfill") {
        window.postMessage(msg, window.location.origin);
      }
      return undefined;
    });
  },
});
