/**
 * Watches Reddit's own save action.
 *
 * This is what makes "save a post, refresh the library, it is there" work —
 * and now "unsave a post, and the library knows it is gone" as well. Save and
 * unsave used to arrive here as the same refresh signal, which meant removing
 * something told Anansi nothing at all.
 *
 * The request says what happened; it does not say what it happened to beyond a
 * fullname, and a fullname is not a link. `t1_abc` cannot be turned into a
 * comment permalink without knowing the post it hangs under. So an accepted
 * mutation is followed by one `/api/info` call in the signed-in page, which
 * returns the same listing shape the server parser already reads — content and
 * event travel together, in one message, in the right order.
 *
 * MAIN world at document_start, because an isolated content script's
 * window.fetch is a different object from the one Reddit's page calls.
 */
import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import {
  infoUrl,
  readInfoObject,
  readSaveMutation,
  retryAfterMs,
} from "../lib/platforms/reddit.ts";

export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    let nonce: string | null = null;
    let watched: string[] = [];
    const matchUrl = (url: string) => watched.some((fragment) => url.includes(fragment));

    const post = (msg: Record<string, unknown>) => {
      if (!nonce) return;
      window.postMessage(
        {
          ...msg,
          anansi: "page-event",
          messageVersion: MESSAGE_PROTOCOL_VERSION,
          source: "reddit",
          nonce,
        },
        window.location.origin,
      );
    };

    /** Fall back to the old behaviour: pull the top of the saved listing. */
    const signal = () => post({ action: "saved" });

    const nativeFetch = window.fetch;

    /**
     * Ask Reddit about exactly one object.
     *
     * One request, using the session the page already has, and it is allowed
     * to fail: a save with no content still becomes a refresh signal, which is
     * how this worked before there was anything better.
     */
    const lookup = async (fullname: string): Promise<unknown | null> => {
      const url = infoUrl(fullname);
      if (!url) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await nativeFetch(url, {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const wait = retryAfterMs(res.status, res.headers.get("retry-after"));
        if (wait !== null) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) return null;
        return await res.json();
      }
      return null;
    };

    const noteMutation = (url: string, body: unknown, ok: boolean) => {
      if (!ok) return;
      const mutation = readSaveMutation(url, body);
      // Not a save endpoint we understand: fall back to the blunt signal so a
      // client change cannot make saving stop working altogether.
      if (!mutation) {
        if (matchUrl(url)) signal();
        return;
      }

      void (async () => {
        const raw = await lookup(mutation.fullname).catch(() => null);
        const object = raw ? readInfoObject(raw, mutation.fullname) : null;
        if (!object) {
          // Nothing to name a location with. A save can still be recovered by
          // re-reading the listing; an unsave has nowhere to go.
          if (mutation.action === "save") signal();
          return;
        }
        post({
          action: "bookmark",
          bookmarkAction: mutation.action,
          externalId: mutation.fullname,
          canonicalUrl: object.canonicalUrl,
          raw,
        });
      })();
    };

    const patched = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const res = await nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (matchUrl(url) || readSaveMutation(url, args[1]?.body ?? null)) {
          const request = input instanceof Request ? input.clone() : null;
          const body = args[1]?.body ?? (request ? await request.text() : null);
          // Only on success: a failed save is not a save.
          noteMutation(url, body, res.ok);
        }
      } catch {
        // Observation must never break the page.
      }
      return res;
    };
    window.fetch = Object.assign(patched, nativeFetch) as typeof fetch;

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
        if (url && (matchUrl(url) || readSaveMutation(url, body ?? null))) {
          this.addEventListener("load", () => {
            noteMutation(url, body ?? null, this.status >= 200 && this.status < 300);
          });
        }
      } catch {
        /* never break the page */
      }
      return nativeSend.call(this, body ?? null);
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: { source?: string; watchUrls?: string[] };
        messageVersion?: number;
        nonce?: string;
      };
      if (
        msg?.anansi === "page-command" &&
        msg.action === "configure" &&
        msg.messageVersion === MESSAGE_PROTOCOL_VERSION &&
        typeof msg.nonce === "string" &&
        msg.config?.source === "reddit"
      ) {
        nonce = msg.nonce;
        watched = msg.config.watchUrls ?? [];
      }
    });
  },
});
