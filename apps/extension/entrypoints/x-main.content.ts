/**
 * Runs in x.com's own JavaScript context, before its bundle boots.
 *
 * MAIN world at document_start is not a preference, it is the only thing that
 * works. A content script in the isolated world at document_idle loads after
 * X has cached its own reference to `fetch`, so patching `window.fetch` then
 * patches an object nobody calls — which produces empty results and looks
 * exactly like X having killed the API.
 *
 * The isolated world also cannot see `window.webpackChunk_twitter_responsive_web`,
 * where the Bookmarks queryId lives, so resolution has to happen here too.
 *
 * This script never talks to any host but x.com. Everything it captures leaves
 * by window.postMessage to the relay, which hands it to the background worker.
 * It holds no token and knows no server, because it shares a context with
 * x.com's own code.
 *
 * Every side effect lives inside main(). WXT imports this module in Node to
 * read the config below, and touching `window` at module scope crashes the
 * build.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";

interface SourceConfig {
  operation: string;
  variables: Record<string, unknown>;
  cursorPrefix: string;
  entryPrefix: string;
  pageLimit: number;
  watchOperations?: string[];
}

type Outbound =
  | { action: "ready"; queryId: string | null }
  | { action: "saved" }
  | { action: "page"; raw: unknown; page: number; items: number }
  | { action: "done"; pages: number; items: number }
  | {
      action: "error";
      errorCode: "platform_request_failed" | "query_unavailable";
    };

/** A public app constant, identical for every visitor — not a user credential. */
const FALLBACK_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
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
          source: "x",
          nonce,
        },
        window.location.origin,
      );
    };

    /** The line that keeps working after X rotates the hash. */
    const scanChunks = (re: RegExp): string | undefined => {
      const chunks = (
        window as unknown as {
          webpackChunk_twitter_responsive_web?: [unknown, Record<string, unknown>][];
        }
      ).webpackChunk_twitter_responsive_web;
      if (!chunks) return undefined;
      for (const [, mods] of chunks) {
        for (const id in mods ?? {}) {
          const m = String(mods[id]).match(re);
          if (m) return m[1] ?? m[0];
        }
      }
      return undefined;
    };

    const resolveQueryId = (operation: string) =>
      scanChunks(new RegExp(`queryId:"([\\w-]+)",operationName:"${operation}"`)) ??
      scanChunks(new RegExp(`operationName:"${operation}",queryId:"([\\w-]+)"`));

    // ---- real-time: watch what the app itself does -------------------------

    let watched: string[] = [];
    const matchOp = (url: string) => watched.find((op) => url.includes(`/${op}`));

    const nativeFetch = window.fetch;
    // Object.assign rather than a bare function: `typeof fetch` carries
    // statics (preconnect) that a plain wrapper would drop, and dropping them
    // silently breaks any page code that touches them.
    const patched = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const res = await nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        // A signal, not a payload. CreateBookmark answers
        // {"data":{"tweet_bookmark_put":"Done"}} — it says that something was
        // bookmarked and nothing about what, so uploading it would parse to
        // zero items and 422 on every save. The background pulls the top of
        // the timeline instead, which arrives with the whole post.
        if (matchOp(url) && res.ok) send({ action: "saved" });
      } catch {
        // Observation must never break the page.
      }
      return res;
    };
    window.fetch = Object.assign(patched, nativeFetch) as typeof fetch;

    // X uses both; hooking only one misses half the traffic.
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        if (matchOp(String(url))) {
          this.addEventListener("load", () => {
            if (this.status >= 200 && this.status < 300) send({ action: "saved" });
          });
        }
      } catch {
        /* never break the page */
      }
      // @ts-expect-error forwarding the original signature verbatim
      return nativeOpen.call(this, method, url, ...rest);
    };

    // ---- backfill: page with the session the browser already has ----------

    const readPage = (json: unknown, cfg: SourceConfig) => {
      const root = json as Record<string, any>;
      const timeline =
        root?.data?.bookmark_timeline_v2?.timeline ?? root?.data?.bookmark_timeline?.timeline;
      const entries: Record<string, any>[] =
        (timeline?.instructions ?? []).find((i: Record<string, any>) => Array.isArray(i.entries))
          ?.entries ?? [];
      const bottom = entries.find((e) => String(e.entryId).startsWith(cfg.cursorPrefix));
      const items = entries.filter((e) => String(e.entryId).startsWith(cfg.entryPrefix)).length;
      return { cursor: (bottom?.content?.value as string | undefined) ?? null, items };
    };

    const backfill = async (cfg: SourceConfig) => {
      const queryId = resolveQueryId(cfg.operation);
      if (!queryId) {
        send({
          action: "error",
          errorCode: "query_unavailable",
        });
        return;
      }

      const bearer = scanChunks(/AAAAAAAA[A-Za-z0-9%\-_]{40,}/) ?? FALLBACK_BEARER;
      const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
      let cursor: string | null = null;
      let page = 0;
      let total = 0;

      for (;;) {
        const variables = { ...cfg.variables, ...(cursor ? { cursor } : {}) };
        const res = await nativeFetch(
          `https://x.com/i/api/graphql/${queryId}/${cfg.operation}` +
            `?variables=${encodeURIComponent(JSON.stringify(variables))}&features=%7B%7D`,
          {
            credentials: "include",
            headers: {
              authorization: `Bearer ${bearer}`,
              "x-csrf-token": csrf,
              "x-twitter-active-user": "yes",
              "x-twitter-auth-type": "OAuth2Session",
            },
          },
        );

        if (res.status === 429) {
          const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000 - Date.now();
          await new Promise((r) => setTimeout(r, Math.min(Math.max(reset, 5000), 300_000)));
          continue;
        }
        if (!res.ok) {
          send({ action: "error", errorCode: "platform_request_failed" });
          return;
        }

        const raw = await res.json();
        const { cursor: next, items } = readPage(raw, cfg);
        page++;
        total += items;

        // Raw and untouched. The server parses it, which is what lets a stale
        // install be repaired without anyone reinstalling anything.
        send({ action: "page", raw, page, items });

        if (items === 0 || !next || next === cursor || page >= cfg.pageLimit) break;
        cursor = next;
      }

      send({ action: "done", pages: page, items: total });
    };

    // ---- commands from the relay ------------------------------------------

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: SourceConfig;
        messageVersion?: number;
        nonce?: string;
      } | undefined;
      if (
        msg?.messageVersion !== 1 ||
        typeof msg.nonce !== "string" ||
        !msg.config
      ) return;
      if (msg.anansi !== "page-command") return;
      if (msg.action === "configure") {
        nonce = msg.nonce;
        watched = msg.config.watchOperations ?? [];
        send({ action: "ready", queryId: resolveQueryId(msg.config.operation) ?? null });
      }
      if (msg.action === "backfill" && msg.nonce === nonce) {
        void backfill(msg.config);
      }
    });
  },
});
