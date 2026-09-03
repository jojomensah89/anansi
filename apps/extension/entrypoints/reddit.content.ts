/**
 * Reddit saved posts and comments.
 *
 * Simpler than X in every way that matters, and the isolated world is enough:
 * there is no queryId buried in a lazily-loaded chunk, so nothing here needs
 * to share Reddit's JavaScript context. A content script's same-origin fetch
 * already carries the session cookies, and extension APIs are available, so
 * this talks to the background worker directly rather than through a relay.
 *
 * It still parses nothing. Raw listings go up exactly as Reddit returned them.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";

interface RedditConfig {
  source: string;
  url: string;
  cursorParam: string;
  cursorPath: string;
  pageLimit: number;
}

export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  runAt: "document_idle",

  main() {
    let nonce: string | null = null;
    const dig = (obj: unknown, path: string): unknown =>
      path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj);

    /**
     * `/user/me/...` is not a real Reddit route — `me` only resolves on the
     * `/api/v1/me` family. So the username is looked up once and substituted.
     */
    const resolveUrl = async (template: string): Promise<string> => {
      if (!template.includes("/user/me/")) return template;
      const res = await fetch("/api/me.json", { credentials: "include" });
      if (!res.ok) throw new Error(`could not identify you (${res.status}) — signed in?`);
      const body = (await res.json()) as { data?: { name?: string } };
      const name = body?.data?.name;
      if (!name) throw new Error("could not identify you — signed in?");
      return template.replace("/user/me/", `/user/${name}/`);
    };

    const backfill = async (config: RedditConfig) => {
      const send = (action: string, payload: Record<string, unknown> = {}) => {
        if (!nonce) return;
        window.postMessage({
          anansi: "page-event",
          action,
          source: "reddit",
          messageVersion: MESSAGE_PROTOCOL_VERSION,
          nonce,
          ...payload,
        }, window.location.origin);
      };

      try {
        const base = await resolveUrl(config.url);
        let after: string | null = null;
        let page = 0;
        let total = 0;

        for (;;) {
          const url = new URL(base, location.origin);
          if (after) url.searchParams.set(config.cursorParam, after);

          const res = await fetch(url.toString(), {
            credentials: "include",
            headers: { accept: "application/json" },
          });

          if (res.status === 429) {
            // Reddit is stricter than X here and says so in a header.
            const wait = Number(res.headers.get("retry-after")) * 1000 || 10_000;
            await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
            continue;
          }
          if (!res.ok) {
            await send("error", { errorCode: "platform_request_failed" });
            return;
          }

          const raw = await res.json();
          const children = (dig(raw, "data.children") as unknown[] | undefined) ?? [];
          page++;
          total += children.length;

          await send("page", { raw, page, items: children.length });

          const next = dig(raw, config.cursorPath) as string | null;
          if (children.length === 0 || !next || next === after || page >= config.pageLimit) break;
          after = next;
        }

        await send("done", { pages: page, items: total });
      } catch (err) {
        void err;
        await send("error", { errorCode: "capture_failed" });
      }
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: RedditConfig;
        messageVersion?: number;
        nonce?: string;
      } | undefined;
      if (
        msg?.anansi === "page-command" &&
        msg.action === "backfill" &&
        msg.messageVersion === MESSAGE_PROTOCOL_VERSION &&
        typeof msg.nonce === "string" &&
        msg.config?.source === "reddit"
      ) {
        nonce = msg.nonce;
        void backfill(msg.config);
      }
    });
  },
});
