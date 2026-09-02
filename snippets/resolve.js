/**
 * Paste into the console of a logged-in x.com tab.
 *
 * Prints the two values the CLI needs when it cannot read them out of the
 * bundles itself. This is the same webpack-chunk walk the build spec
 * describes — the line that keeps working after X rotates the hash.
 */
(() => {
  const findQuery = (name) => {
    for (const [, mods] of window.webpackChunk_twitter_responsive_web ?? []) {
      for (const id in mods ?? {}) {
        const m = String(mods[id]).match(
          new RegExp(`queryId:"([\w-]+)",operationName:"${name}"`),
        );
        if (m) return m[1];
      }
    }
  };

  const bearer = [...document.querySelectorAll("script[src]")]
    .map((s) => s.src)
    .find((s) => s.includes("/main."));

  console.log("X_BOOKMARKS_QUERY_ID=" + (findQuery("Bookmarks") ?? "NOT FOUND"));
  console.log("X_CSRF_TOKEN=" + (document.cookie.match(/ct0=([^;]+)/)?.[1] ?? "NOT FOUND"));
  console.log("main bundle (grep it for AAAAAAAA… to get X_BEARER):", bearer);
})();
