import { createNativeSnapshotCache, nativeItemsFromPayload } from "../lib/native-snapshot.ts";
import type { NormalizedItem } from "@anansi/sources";
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
 * comment permalink without knowing the post it hangs under. Posts already
 * visible to the page are captured from the local snapshot cache; a save with
 * no cached content gets one `/api/info` lookup to enrich the same event.
 *
 * MAIN world at document_start, before Reddit's bundle can cache its own
 * window.fetch reference. Only recognized save operations become mutations.
 */
import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import {
  observeRedditFetch,
  type RedditFetchObservationDetails,
} from "../lib/reddit-fetch-observer.ts";
import {
  infoUrl,
  isRedditGraphqlEndpoint,
  isRedditMutationEndpoint,
  isSaveMutationAccepted,
  needsRedditResponseBody,
  shouldRefreshSavedListingAfterUnknownGraphqlMutation,
  readSaveMutation,
  retryAfterMs,
  type SaveMutation,
} from "../lib/platforms/reddit.ts";
import {
  createNativeTransitionOrder,
  type NativeTransitionConfirmation,
} from "../lib/native-transition-order.ts";

export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    const snapshots = createNativeSnapshotCache("reddit");
    const transitions = createNativeTransitionOrder();
    const waiting: Record<string, unknown>[] = [];
    type NativeTraceFields = {
      recognized?: boolean;
      receiptAccepted?: boolean;
      startingContent?: boolean;
      confirmed?: boolean;
    };
    const traceNative = (stage: string, fields: NativeTraceFields = {}) => {
      try {
        console.debug("[Anansi native Reddit]", { stage, ...fields });
      } catch {
        // Diagnostics must never affect Reddit's page.
      }
    };
    let nonce: string | null = null;
    let watched: string[] = [];
    const redditRequestUrl = (value: string): string | undefined => {
      try {
        const url = new URL(value, window.location.origin);
        if (
          url.protocol !== "https:" ||
          url.port ||
          !["www.reddit.com", "old.reddit.com", "reddit.com"].includes(
            url.hostname,
          )
        ) {
          return;
        }
        return url.toString();
      } catch {
        return;
      }
    };
    const matchUrl = (url: string) => watched.some((fragment) => url.includes(fragment));
    const snapshotFor = (id: string): NormalizedItem | undefined => {
      try {
        return snapshots.get(id);
      } catch {
        return undefined;
      }
    };

    type MutationCapture = {
      mutation: SaveMutation;
      identity: { mutationId: string; observedAt: number };
      startingItem?: NormalizedItem;
      transition: NativeTransitionConfirmation | null;
    };
    type MutationRequest = {
      identity: MutationCapture["identity"];
      requestBodyWasUnavailable: boolean;
      capture: Promise<MutationCapture | null>;
    };

    const beginMutation = (
      url: string,
      body: Promise<unknown>,
      initialBody: { available: boolean; value: unknown },
    ): MutationRequest | undefined => {
      if (!isRedditMutationEndpoint(url)) return undefined;
      const reservation = transitions.reserve();
      const identity = {
        mutationId: crypto.randomUUID(),
        observedAt: Math.floor(Date.now() / 1000),
      };
      const bind = (rawBody: unknown): MutationCapture | null => {
        let mutation: SaveMutation | null;
        try {
          mutation = readSaveMutation(url, rawBody);
        } catch {
          mutation = null;
        }
        if (!mutation) {
          reservation.skip();
          return null;
        }
        const transition = reservation.bind(mutation.fullname);
        if (!transition) return null;
        return {
          mutation,
          identity,
          startingItem: snapshotFor(mutation.fullname),
          transition,
        };
      };
      const capture = initialBody.available
        ? Promise.resolve(bind(initialBody.value))
        : body.then(bind, () => {
            reservation.skip();
            return null;
          });
      return {
        identity,
        requestBodyWasUnavailable: !initialBody.available,
        capture,
      };
    };

    const post = (msg: Record<string, unknown>) => {
      if (!nonce) {
        if (waiting.length < 100) {
          waiting.push(msg);
          if (msg.action === "bookmark") {
            traceNative("event-queued", {
              recognized: true,
              receiptAccepted: true,
              startingContent: Boolean(msg.normalizedItem),
              confirmed: true,
            });
          }
        } else if (msg.action === "bookmark") {
          traceNative("event-queue-full", {
            recognized: true,
            receiptAccepted: true,
            startingContent: Boolean(msg.normalizedItem),
            confirmed: true,
          });
        }
        return;
      }
      if (msg.action === "bookmark") {
        traceNative("event-posted", {
          recognized: true,
          receiptAccepted: true,
          startingContent: Boolean(msg.normalizedItem),
          confirmed: true,
        });
      }
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
          signal: AbortSignal.timeout(15_000),
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

    const emitMutation = (capture: MutationCapture) => {
      const { mutation, identity, startingItem, transition } = capture;
      if (!transition) return;
      const event = {
        action: "bookmark",
        bookmarkAction: mutation.action,
        externalId: mutation.fullname,
        ...identity,
        canonicalUrl:
          startingItem?.url ??
          `https://www.reddit.com/comments/${mutation.fullname.replace(/^t[13]_/, "")}`,
      };
      const confirmed = transition.confirm(() => {
        post({
          ...event,
          ...(mutation.action === "save" && startingItem
            ? { normalizedItem: startingItem }
            : {}),
        });
        // The confirmed mutation is durable before this optional single-item
        // lookup; reuse its identity so a late result cannot reorder events.
        if (mutation.action === "save" && !startingItem) {
          void lookup(mutation.fullname)
            .then((raw) => {
              const item = nativeItemsFromPayload(
                "reddit",
                raw,
                identity.observedAt,
              ).find((candidate) => candidate.externalId === mutation.fullname);
              if (item) post({ ...event, canonicalUrl: item.url, normalizedItem: item });
            })
            .catch(() => {});
        }
      });
      traceNative("transition-confirmed", {
        recognized: true,
        receiptAccepted: true,
        startingContent: Boolean(startingItem),
        confirmed,
      });
      // A successful response can arrive after this item's ordering lease has
      // expired. Its event can no longer be ordered safely, so reconcile the
      // saved listing now that native success is confirmed.
      if (!confirmed) signal();
    };

    const noteMutation = (
      url: string,
      body: unknown,
      ok: boolean,
      details?: RedditFetchObservationDetails,
    ) => {
      const request = details?.request as MutationRequest | undefined;
      let recognized = false;
      try {
        recognized = readSaveMutation(url, body) !== null;
      } catch {
        recognized = false;
      }
      traceNative("response-observed", { recognized });
      if (!ok) {
        if (request) {
          void request.capture.then((capture) => {
            traceNative("http-rejected", {
              recognized: Boolean(capture),
              receiptAccepted: false,
              startingContent: Boolean(capture?.startingItem),
              confirmed: false,
            });
            capture?.transition?.fail();
          });
        } else {
          traceNative("http-rejected", {
            recognized,
            receiptAccepted: false,
            startingContent: false,
            confirmed: false,
          });
        }
        return;
      }
      if (request) {
        void request.capture
          .then((capture) => {
            if (!capture) {
              // Keep the old refresh fallback for unknown legacy routes, while
              // ignoring unrelated operations sent to the GraphQL endpoint.
              // A missing GraphQL Request clone is ambiguous; a saved-list
              // refresh reconciles actual server state without guessing which
              // object or action the unreadable request contained.
              const refreshUnknownGraphql =
                isRedditGraphqlEndpoint(url) &&
                shouldRefreshSavedListingAfterUnknownGraphqlMutation(
                  request.requestBodyWasUnavailable,
                  body,
                  details?.responseBody,
                );
              const refreshLegacy = !isRedditGraphqlEndpoint(url) && matchUrl(url);
              traceNative("capture-unrecognized", {
                recognized: false,
                receiptAccepted: refreshUnknownGraphql,
                startingContent: false,
                confirmed: false,
              });
              if (refreshLegacy || refreshUnknownGraphql) {
                traceNative("saved-list-refresh", {
                  recognized: false,
                  receiptAccepted: refreshUnknownGraphql,
                  startingContent: false,
                  confirmed: false,
                });
                signal();
              }
              return;
            }
            const receiptAccepted = isSaveMutationAccepted(
              capture.mutation,
              true,
              details?.responseBody,
            );
            traceNative("receipt", {
              recognized: true,
              receiptAccepted,
              startingContent: Boolean(capture.startingItem),
            });
            if (!capture.transition) {
              traceNative("transition-unavailable", {
                recognized: true,
                receiptAccepted,
                startingContent: Boolean(capture.startingItem),
                confirmed: false,
              });
              if (matchUrl(url)) signal();
              return;
            }
            if (!receiptAccepted) {
              capture.transition.fail();
              // The source listing reconciles current server state when the
              // mutation succeeded over HTTP but its GraphQL receipt could
              // not be read. An explicit GraphQL error remains a hard reject.
              if (
                capture.mutation.transport === "shreddit-graphql" &&
                details?.responseBody == null
              ) {
                traceNative("unreadable-receipt-refresh", {
                  recognized: true,
                  receiptAccepted: false,
                  startingContent: Boolean(capture.startingItem),
                  confirmed: false,
                });
                signal();
              }
              return;
            }
            emitMutation(capture);
          })
          .catch(() => {
            traceNative("capture-error", {
              recognized,
              receiptAccepted: false,
              startingContent: false,
              confirmed: false,
            });
          });
        return;
      }
      // Preserve the broad refresh signal used for explicitly watched routes.
      if (matchUrl(url)) {
        traceNative("watched-refresh", {
          recognized,
          receiptAccepted: false,
          startingContent: false,
          confirmed: false,
        });
        signal();
      }
    };

    window.fetch = observeRedditFetch(
      nativeFetch,
      (value) => {
        const url = redditRequestUrl(value);
        return Boolean(
          url && (isRedditMutationEndpoint(url) || matchUrl(url)),
        );
      },
      noteMutation,
      {
        onRequestStart: (url, body, initialBody) =>
          beginMutation(url, body, initialBody),
        needsResponseBody: (url, body) => needsRedditResponseBody(url, body),
      },
    );

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
        const safeUrl = redditRequestUrl(url);
        if (safeUrl && (isRedditMutationEndpoint(safeUrl) || matchUrl(safeUrl))) {
          const requestBody = body ?? null;
          const request = beginMutation(
            safeUrl,
            Promise.resolve(requestBody),
            { available: true, value: requestBody },
          );
          this.addEventListener("load", () => {
            const ok = this.status >= 200 && this.status < 300;
            let responseBody: unknown;
            if (ok && request) {
              try {
                responseBody =
                  this.responseType === "json"
                    ? this.response
                    : JSON.parse(this.responseText);
              } catch {
                responseBody = null;
              }
            }
            noteMutation(safeUrl, requestBody, ok, {
              ...(request === undefined ? {} : { request }),
              ...(responseBody === undefined ? {} : { responseBody }),
            });
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
        for (const message of waiting.splice(0)) post(message);
        watched = msg.config.watchUrls ?? [];
      }
    });
  },
});
