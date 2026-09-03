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

interface SourceConfig {
  operation: string;
  variables: Record<string, unknown>;
  cursorPrefix: string;
  entryPrefix: string;
  pageLimit: number;
  watchOperations?: string[];
}

type Outbound =
  | { anansi: "ready"; queryId: string | null }
  | { anansi: "page"; raw: unknown; page: number; items: number }
  | { anansi: "observed"; operation: string; raw: unknown }
  | { anansi: "done"; pages: number; items: number }
  | { anansi: "error"; message: string };

/** A public app constant, identical for every visitor — not a user credential. */
const FALLBACK_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    const send = (msg: Outbound) => window.postMessage(msg, window.location.origin);

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
        const operation = matchOp(url);
        if (operation) {
          // Cloned so the app still gets its body intact.
          res
            .clone()
            .json()
            .then((raw) => send({ anansi: "observed", operation, raw }))
            .catch(() => {});
        }
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
        const operation = matchOp(String(url));
        if (operation) {
          this.addEventListener("load", () => {
            try {
              send({ anansi: "observed", operation, raw: JSON.parse(this.responseText) });
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
          anansi: "error",
          message: `Could not find the ${cfg.operation} queryId. Open x.com/i/bookmarks so the chunk loads, then try again.`,
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
          send({ anansi: "error", message: `x returned ${res.status}` });
          return;
        }

        const raw = await res.json();
        const { cursor: next, items } = readPage(raw, cfg);
        page++;
        total += items;

        // Raw and untouched. The server parses it, which is what lets a stale
        // install be repaired without anyone reinstalling anything.
        send({ anansi: "page", raw, page, items });

        if (items === 0 || !next || next === cursor || page >= cfg.pageLimit) break;
        cursor = next;
      }

      send({ anansi: "done", pages: page, items: total });
    };

    // ---- commands from the relay ------------------------------------------

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as { anansi?: string; config?: SourceConfig } | undefined;
      if (!msg?.config) return;
      if (msg.anansi === "configure") {
        watched = msg.config.watchOperations ?? [];
        send({ anansi: "ready", queryId: resolveQueryId(msg.config.operation) ?? null });
      }
      if (msg.anansi === "backfill") {
        void backfill(msg.config);
      }
    });
  },
});
