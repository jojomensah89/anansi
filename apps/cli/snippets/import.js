/**
 * Anansi importer — runs in the page, not in the CLI.
 *
 * Paste into the console of a logged-in x.com tab with Bookmarks open.
 *
 * You never see, type, or store a credential. `credentials: "include"` makes
 * the browser attach its own cookie jar; ct0 is read in-page for the CSRF
 * header exactly as x.com's own code does, and never leaves the tab.
 *
 * Transport note: x.com's CSP `connect-src` has no 127.0.0.1, so this page
 * cannot POST to Anansi directly. CSP governs connections, not windows — so
 * a bridge window is opened on Anansi's own origin and the payload crosses
 * by postMessage. If the popup is blocked, everything is written to a single
 * JSON file instead, which `anansi ingest --file` reads.
 *
 * `anansi ingest` prints this with ENDPOINT and TOKEN already filled in.
 */
(() => {
  const ENDPOINT = "__ANANSI_ENDPOINT__";
  const PAGE_SIZE = 100;

  const log = (...a) =>
    console.log("%c anansi ", "background:#E4A33C;color:#0B0E11;border-radius:3px", ...a);

  // Opened synchronously, before any await, or the popup blocker eats it.
  const bridge = window.open(ENDPOINT + "/bridge", "anansi_bridge", "width=460,height=320");
  if (!bridge) {
    log("popup blocked — falling back to a downloaded file at the end.");
  }

  const pending = new Map();
  let nextId = 1;
  let bridgeReady = false;

  addEventListener("message", (ev) => {
    if (ev.origin !== new URL(ENDPOINT).origin) return;
    const msg = ev.data;
    if (msg?.anansi === "ready") { bridgeReady = true; return; }
    if (msg?.anansi === "ack") pending.get(msg.id)?.(msg);
  });

  const waitForBridge = () =>
    new Promise((resolve) => {
      if (!bridge) return resolve(false);
      const started = Date.now();
      const tick = () => {
        if (bridgeReady) return resolve(true);
        if (Date.now() - started > 10_000) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });

  const send = (body) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, (msg) => { pending.delete(id); resolve(msg); });
      bridge.postMessage({ anansi: "send", id, body }, new URL(ENDPOINT).origin);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, text: "bridge timeout" }); }
      }, 30_000);
    });

  const download = (pages) => {
    const blob = new Blob([JSON.stringify({ source: "x", pages })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "anansi-bookmarks.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    log("saved anansi-bookmarks.json — now run:  anansi ingest --file <path to it>");
  };

  /** The queryId lives in a lazily loaded chunk, not the main bundle. */
  const scanChunks = (re) => {
    for (const [, mods] of window.webpackChunk_twitter_responsive_web ?? []) {
      for (const id in mods ?? {}) {
        const m = String(mods[id]).match(re);
        if (m) return m[1] ?? m[0];
      }
    }
  };

  (async () => {
    const queryId =
      scanChunks(/queryId:"([\w-]+)",operationName:"Bookmarks"/) ??
      scanChunks(/operationName:"Bookmarks",queryId:"([\w-]+)"/);

    if (!queryId) {
      console.error(
        "anansi: couldn't find the Bookmarks queryId.\n" +
          "Open https://x.com/i/bookmarks first so the chunk loads, then rerun this.",
      );
      return;
    }

    // Public app constant, identical for every visitor — not a user credential.
    const bearer =
      scanChunks(/AAAAAAAA[A-Za-z0-9%\-_]{40,}/) ??
      "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1];

    const live = await waitForBridge();
    log(live ? "bridge connected." : "no bridge — collecting to a file.");
    log("queryId", queryId, "— starting");

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

    const readPage = (json) => {
      const instructions = json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
      const entries = instructions.find((i) => Array.isArray(i.entries))?.entries ?? [];
      const bottom = entries.find((e) => String(e.entryId).startsWith("cursor-bottom"));
      const tweets = entries.filter((e) => String(e.entryId).startsWith("tweet-")).length;
      return { cursor: bottom?.content?.value ?? null, tweets };
    };

    const collected = [];
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
        const wait = Math.min(Math.max(reset, 5_000), 5 * 60_000);
        log(`rate limited — waiting ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.error("anansi: x returned", res.status, await res.text());
        return;
      }

      const json = await res.json();
      const { cursor: next, tweets } = readPage(json);
      page++;
      total += tweets;

      if (live) {
        const ack = await send({ source: "x", page, raw: json });
        if (!ack.ok) {
          console.error("anansi: bridge rejected page", page, ack.text);
          return;
        }
      } else {
        collected.push({ page, raw: json });
      }

      log(`page ${page} — ${tweets} items — ${total} total`);

      if (tweets === 0 || !next || next === cursor) break;
      cursor = next;
    }

    if (live) {
      const done = await send({ source: "x", done: true, pages: page, items: total });
      log(`finished — ${page} pages, ${total} items.`, done.text ?? "");
      log("you can close the bridge tab now.");
    } else {
      download(collected);
    }
  })();
})();
