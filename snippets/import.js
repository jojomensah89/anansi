/**
 * Anansi importer — runs in the page, not in the CLI.
 *
 * Paste into the console of a logged-in x.com tab with the Bookmarks tab
 * open. It pages your bookmarks using the session the browser already has
 * and POSTs each raw payload to the local Anansi server.
 *
 * You never see, type, or store a credential. `credentials: "include"` makes
 * the browser attach its own cookie jar; ct0 is read in-page for the CSRF
 * header exactly as x.com's own code does, and is never sent to Anansi.
 * What crosses to localhost is the untouched bookmark payload and nothing
 * else.
 *
 * `anansi ingest` prints this with ENDPOINT and TOKEN already filled in.
 */
(async () => {
  const ENDPOINT = "__ANANSI_ENDPOINT__";
  const TOKEN = "__ANANSI_TOKEN__";
  const PAGE_SIZE = 100;

  const log = (...a) => console.log("%c anansi ", "background:#E4A33C;color:#0B0E11", ...a);

  /**
   * The queryId is not in the main bundle — it lives in a lazily loaded
   * chunk. This is the line that keeps working after X rotates the hash.
   */
  const scanChunks = (re) => {
    for (const [, mods] of window.webpackChunk_twitter_responsive_web ?? []) {
      for (const id in mods ?? {}) {
        const m = String(mods[id]).match(re);
        if (m) return m[1] ?? m[0];
      }
    }
  };

  const queryId = scanChunks(/queryId:"([\w-]+)",operationName:"Bookmarks"/)
    ?? scanChunks(/operationName:"Bookmarks",queryId:"([\w-]+)"/);

  if (!queryId) {
    console.error(
      "anansi: couldn't find the Bookmarks queryId.\n" +
      "Open https://x.com/i/bookmarks first so the chunk loads, then rerun this.",
    );
    return;
  }

  // Public app constant, identical for every visitor — not a user credential.
  const bearer = scanChunks(/AAAAAAAA[A-Za-z0-9%\-_]{40,}/)
    ?? "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1];

  const call = (vars) =>
    fetch(
      `https://x.com/i/api/graphql/${queryId}/Bookmarks` +
        `?variables=${encodeURIComponent(JSON.stringify(vars))}&features=%7B%7D`,
      {
        credentials: "include",
        headers: {
          authorization: "Bearer " + bearer,
          "x-csrf-token": csrf,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
        },
      },
    );

  const send = (body) =>
    fetch(ENDPOINT + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anansi-token": TOKEN },
      body: JSON.stringify(body),
    });

  const cursorOf = (json) => {
    const instructions =
      json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
    const entries = instructions.find((i) => Array.isArray(i.entries))?.entries ?? [];
    const bottom = entries.find((e) => String(e.entryId).startsWith("cursor-bottom"));
    const tweets = entries.filter((e) => String(e.entryId).startsWith("tweet-")).length;
    return { cursor: bottom?.content?.value ?? null, tweets };
  };

  log("queryId", queryId, "- starting");

  let cursor = null;
  let page = 0;
  let total = 0;

  for (;;) {
    const res = await call({
      count: PAGE_SIZE,
      includePromotedContent: false,
      ...(cursor ? { cursor } : {}),
    });

    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000 - Date.now();
      const wait = Math.min(Math.max(reset, 5000), 5 * 60_000);
      log(`rate limited, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      console.error("anansi: x returned", res.status, await res.text());
      return;
    }

    const json = await res.json();
    const { cursor: next, tweets } = cursorOf(json);
    page++;
    total += tweets;

    const ack = await send({ source: "x", page, raw: json });
    if (!ack.ok) {
      console.error("anansi: local server rejected page", page, await ack.text());
      return;
    }

    log(`page ${page} - ${tweets} items - ${total} total`);

    if (tweets === 0 || !next || next === cursor) break;
    cursor = next;
  }

  const done = await send({ source: "x", done: true, pages: page, items: total });
  log(`finished - ${page} pages, ${total} items.`, await done.text());
})();
