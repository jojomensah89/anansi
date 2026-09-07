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
 * x.com's own code. The bearer and `ct0` it reads are used in the request it
 * is making and are never sent anywhere.
 *
 * Every side effect lives inside main(). WXT imports this module in Node to
 * read the config below, and touching `window` at module scope crashes the
 * build.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import {
  buildTimelineUrl,
  isMutationAccepted,
  readBookmarkMutation,
  readRequestTemplate,
  readTimelinePage,
  shouldStopImport,
  type RequestTemplate,
} from "../lib/platforms/x.ts";

interface SourceConfig {
  operation: string;
  variables: Record<string, unknown>;
  cursorPrefix: string;
  entryPrefix: string;
  pageLimit: number;
  watchOperations?: string[];
  /** Where the last acknowledged run stopped, if it stopped part-way. */
  resumeCursor?: string;
}

type Outbound =
  | { action: "ready"; queryId: string | null }
  | { action: "bookmark"; bookmarkAction: "save" | "unsave"; externalId: string }
  | {
      action: "page";
      runId?: string;
      raw: unknown;
      page: number;
      items: number;
      cursor?: string;
    }
  | {
      action: "done";
      runId?: string;
      pages: number;
      items: number;
      state?: "complete" | "limited" | "cancelled";
    }
  | {
      action: "error";
      runId?: string;
      errorCode: "platform_request_failed" | "query_unavailable";
    };

/** A public app constant, identical for every visitor — not a user credential. */
const FALLBACK_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/** How long a backfill waits for X to make a Bookmarks request of its own. */
const TEMPLATE_WAIT_MS = 12_000;

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    let nonce: string | null = null;
    let activeRunId: string | null = null;
    const send = (msg: Outbound) => {
      if (!nonce) return;
      const correlated =
        msg.action === "page" || msg.action === "done" || msg.action === "error";
      const outbound =
        correlated && activeRunId
          ? { ...msg, runId: msg.runId ?? activeRunId }
          : msg;
      window.postMessage(
        {
          ...outbound,
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

    // ---- what the app does for itself -------------------------------------

    let watched: string[] = [];
    let timelineOperation: string | null = null;

    /**
     * The last Bookmarks request X made and X liked.
     *
     * This is the whole point of watching the timeline query rather than only
     * the mutations: the import stops guessing which feature flags X wants
     * this week and reuses the ones it just accepted.
     */
    let observed: RequestTemplate | null = null;

    const matchOp = (url: string) => watched.find((op) => url.includes(`/${op}`));

    const noteTemplate = (url: string) => {
      if (!timelineOperation || !url.includes(`/${timelineOperation}`)) return;
      const template = readRequestTemplate(url, timelineOperation);
      if (template) observed = template;
    };

    /**
     * Report a mutation only when X both understood it and applied it.
     *
     * Create and Delete used to arrive here as the same word, which is why an
     * unbookmark did nothing: the library never heard that anything had been
     * removed. Now the operation name decides the action and the request body
     * says which post it applies to.
     */
    const noteMutation = (url: string, body: unknown, status: number, response: unknown) => {
      const mutation = readBookmarkMutation(url, body);
      if (!mutation) return;
      if (!isMutationAccepted(status, response)) return;
      send({
        action: "bookmark",
        bookmarkAction: mutation.action,
        externalId: mutation.tweetId,
      });
    };

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

        if (res.ok) noteTemplate(url);

        if (matchOp(url)) {
          const request = input instanceof Request ? input.clone() : null;
          const body = args[1]?.body ?? (request ? await request.text() : null);
          const text = await res
            .clone()
            .text()
            .catch(() => null);
          noteMutation(url, body, res.status, text);
        }
      } catch {
        // Observation must never break the page.
      }
      return res;
    };
    window.fetch = Object.assign(patched, nativeFetch) as typeof fetch;

    // X uses both; hooking only one misses half the traffic.
    type WatchedXhr = XMLHttpRequest & { __anansiUrl?: string };

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: WatchedXhr,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        this.__anansiUrl = String(url);
      } catch {
        /* never break the page */
      }
      // @ts-expect-error forwarding the original signature verbatim
      return nativeOpen.call(this, method, url, ...rest);
    };

    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (
      this: WatchedXhr,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      try {
        const url = this.__anansiUrl ?? "";
        if (url) {
          this.addEventListener("load", () => {
            try {
              if (this.status >= 200 && this.status < 300) noteTemplate(url);
              if (matchOp(url)) {
                noteMutation(
                  url,
                  typeof body === "string" ? body : null,
                  this.status,
                  this.responseText,
                );
              }
            } catch {
              /* never break the page */
            }
          });
        }
      } catch {
        /* never break the page */
      }
      return nativeSend.call(this, body ?? null);
    };

    // ---- backfill: page with the session the browser already has ----------

    /**
     * Wait a little for X to ask for its own bookmarks.
     *
     * On x.com/i/bookmarks it always does, within a second or two of load. The
     * wait is what buys the observed feature set; the fallback below is what
     * keeps an import possible if the page never gets there.
     */
    const waitForTemplate = async (): Promise<RequestTemplate | null> => {
      const deadline = Date.now() + TEMPLATE_WAIT_MS;
      while (!observed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return observed;
    };

    const reconstruct = (cfg: SourceConfig, cursor: string | null): string | null => {
      const queryId = resolveQueryId(cfg.operation);
      if (!queryId) return null;
      const variables = { ...cfg.variables, ...(cursor ? { cursor } : {}) };
      return (
        `https://x.com/i/api/graphql/${queryId}/${cfg.operation}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}&features=%7B%7D`
      );
    };

    const backfill = async (cfg: SourceConfig, runId: string) => {
      timelineOperation = cfg.operation;
      const template = await waitForTemplate();
      if (!template && !resolveQueryId(cfg.operation)) {
        send({ action: "error", runId, errorCode: "query_unavailable" });
        return;
      }

      const bearer = scanChunks(/AAAAAAAA[A-Za-z0-9%\-_]{40,}/) ?? FALLBACK_BEARER;
      const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
      let cursor: string | null = cfg.resumeCursor ?? null;
      let page = 0;
      let total = 0;
      let limited = false;

      for (;;) {
        // Prefer whatever X most recently used; it may improve mid-run.
        const url = (observed ? buildTimelineUrl(observed, cursor) : null) ??
          reconstruct(cfg, cursor);
        if (!url) {
          send({ action: "error", runId, errorCode: "query_unavailable" });
          return;
        }

        const res = await nativeFetch(url, {
          credentials: "include",
          headers: {
            authorization: `Bearer ${bearer}`,
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
          },
        });

        if (res.status === 429) {
          const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000 - Date.now();
          await new Promise((r) => setTimeout(r, Math.min(Math.max(reset, 5000), 300_000)));
          continue;
        }
        if (!res.ok) {
          send({ action: "error", runId, errorCode: "platform_request_failed" });
          return;
        }

        const raw = await res.json();
        const read = readTimelinePage(raw, cfg);
        page++;
        total += read.items;

        // Raw and untouched. The server parses it, which is what lets a stale
        // install be repaired without anyone reinstalling anything.
        send({
          action: "page",
          runId,
          raw,
          page,
          items: read.items,
          ...(read.cursor ? { cursor: read.cursor } : {}),
        });

        const decision = shouldStopImport({
          page,
          pageLimit: cfg.pageLimit,
          items: read.items,
          cursor: read.cursor,
          previousCursor: cursor,
        });
        if (decision.stop) {
          limited = decision.reason === "page_limit";
          break;
        }
        cursor = read.cursor;
      }

      send({
        action: "done",
        runId,
        pages: page,
        items: total,
        // A page limit is a resumable boundary, not a genuine end.
        state: limited ? "limited" : "complete",
      });
    };

    // ---- commands from the relay ------------------------------------------

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: SourceConfig;
        runId?: string;
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
        activeRunId = typeof msg.runId === "string" ? msg.runId : null;
        watched = msg.config.watchOperations ?? [];
        timelineOperation = msg.config.operation;
        send({ action: "ready", queryId: resolveQueryId(msg.config.operation) ?? null });
      }
      if (
        msg.action === "backfill" &&
        msg.nonce === nonce &&
        typeof msg.runId === "string" &&
        msg.runId === activeRunId
      ) {
        void backfill(msg.config, msg.runId);
      }
    });
  },
});
