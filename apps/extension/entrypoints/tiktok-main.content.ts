import { createNativeSnapshotCache } from "../lib/native-snapshot.ts";
import { xhrResponseJson } from "../lib/xhr-response.ts";
import type { NormalizedItem } from "@anansi/sources";
/**
 * TikTok favourites, by observation.
 *
 * There is no backfill to write. TikTok publishes no favourites endpoint and
 * signs its web requests — X-Bogus and msToken are computed by its own
 * bundle — so nothing outside the app can forge one. What can be done is
 * watch the requests the app makes for itself while your favourites load, and
 * keep the responses.
 *
 * What has changed is that you no longer have to do the loading. This reports
 * the signed-in handle so the extension can send the tab to your own profile,
 * opens the Favourites tab, and scrolls it. Pressing Import is the whole
 * interaction; "scroll your favourites to capture them" was never an
 * instruction anyone should have been given.
 *
 * Favourites and Likes are different actions and are kept apart deliberately:
 * only the collected-item listing is a bookmark here.
 *
 * MAIN world at document_start for the same reason as x-main: patching fetch
 * after the app has cached its own reference patches nothing.
 */

import { MESSAGE_PROTOCOL_VERSION } from "../lib/messages.ts";
import {
  createNativeTransitionOrder,
  type NativeTransitionConfirmation,
  type NativeTransitionReservation,
} from "../lib/native-transition-order.ts";
import {
  FAVOURITES_TAB_SELECTORS,
  isFavouritesRequest,
  readHandle,
  readAccountInfo,
  readHandleFromProfileHref,
  readItemList,
  readFavouriteMutation,
  isSuccessfulMutationResponse,
  type FavouriteMutation,
} from "../lib/platforms/tiktok.ts";

type Outbound =
  | { action: "observed"; operation: string; raw: unknown; items: number; runId: string }
  | { action: "identified"; handle: string; runId: string }
  | { action: "scanned"; runId: string }
  | { action: "error"; errorCode: "capture_failed" | "not_signed_in"; runId: string }
  | { action: "saved" }
  | { action: "bookmark"; bookmarkAction: "save" | "unsave"; externalId: string; canonicalUrl: string; normalizedItem?: NormalizedItem; mutationId: string; observedAt: number };

interface ScanConfig {
  source: string;
  watchUrls?: string[];
  mutationUrl?: string;
  idField?: string;
  actionField?: string;
  savedValue?: string;
  unsavedValue?: string;
}

export default defineContentScript({
  matches: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    const snapshots = createNativeSnapshotCache("tiktok");
    const transitions = createNativeTransitionOrder();
    const waiting: Outbound[] = [];
    const snapshotFor = (id: string): NormalizedItem | undefined => {
      try {
        return snapshots.get(id);
      } catch {
        return undefined;
      }
    };
    let nonce: string | null = null;
    let activeRunId: string | null = null;
    const send = (msg: Outbound) => {
      if (!nonce) { if ((msg.action === "bookmark" || msg.action === "saved") && waiting.length < 100) waiting.push(msg); return; }
      window.postMessage(
        {
          ...msg,
          anansi: "page-event",
          messageVersion: MESSAGE_PROTOCOL_VERSION,
          source: "tiktok",
          nonce,
        },
        window.location.origin,
      );
    };

    let watched: string[] = [];
    let mutationConfig: ScanConfig = { source: "tiktok" };
    let scanning = false;
    let sawFavoritesResponse = false;
    /** Set by any observed Favourites page that said there is more. */
    let moreToLoad = true;

    /** Only pass on a Favourites payload that actually carries items. */
    const forward = (operation: string, raw: unknown) => {
      if (!raw || typeof raw !== "object" ||
        (!Array.isArray((raw as { itemList?: unknown }).itemList) && !Array.isArray((raw as { items?: unknown }).items))) return;
      sawFavoritesResponse = true;
      const page = readItemList(raw);
      moreToLoad = page.hasMore;
      if (page.count === 0) return;
      if (activeRunId) send({ action: "observed", operation, raw, items: page.count, runId: activeRunId });
    };

    const matchUrl = (url: string) =>
      isFavouritesRequest(url, { watchUrls: watched })
        ? (watched.find((fragment) => url.includes(fragment)) ?? "favourites")
        : null;
    const isMutationEndpoint = (url: string, config: ScanConfig) => {
      if (!config.mutationUrl) return false;
      try {
        const parsed = new URL(url, "https://www.tiktok.com");
        const host = parsed.hostname.toLowerCase();
        return (
          (host === "www.tiktok.com" || host === "tiktok.com") &&
          parsed.pathname.includes(config.mutationUrl)
        );
      } catch {
        return false;
      }
    };

    type MutationCapture = {
      mutation: FavouriteMutation;
      identity: { mutationId: string; observedAt: number };
      transition: NativeTransitionConfirmation;
      startingItem?: NormalizedItem;
      recoverySent: boolean;
    };
    const recoverMutation = (
      capture: MutationCapture | null,
      fallback: (force?: boolean) => void,
      force = false,
    ) => {
      if (!capture) {
        fallback(force);
        return;
      }
      if (capture.recoverySent && !force) return;
      capture.recoverySent = true;
      send({ action: "saved" });
    };
    const captureMutation = (
      url: string,
      body: unknown,
      identity: MutationCapture["identity"],
      reservation: NativeTransitionReservation,
      requestFailed: () => boolean,
      config: ScanConfig = mutationConfig,
    ): MutationCapture | null => {
      if (requestFailed()) {
        reservation.skip();
        return null;
      }
      let mutation: FavouriteMutation | null;
      try {
        mutation = readFavouriteMutation(url, body, config);
      } catch {
        reservation.skip();
        return null;
      }
      if (!mutation) {
        reservation.skip();
        return null;
      }
      let startingItem: NormalizedItem | undefined;
      if (mutation.action === "save") {
        startingItem = snapshotFor(mutation.videoId);
      }
      const transition = reservation.bind(mutation.videoId);
      if (!transition) return null;
      const capture = {
        mutation,
        identity,
        transition,
        recoverySent: false,
        ...(startingItem ? { startingItem } : {}),
      };
      void transition.timedOut.then((timedOut) => {
        if (timedOut) recoverMutation(capture, () => {});
      });
      return capture;
    };
    const forwardMutation = (
      capture: MutationCapture | null,
      raw: unknown,
      identityUnavailable = false,
      recover: () => void = () => send({ action: "saved" }),
    ) => {
      if (!capture) {
        if (identityUnavailable && isSuccessfulMutationResponse(raw)) recover();
        return;
      }
      if (!isSuccessfulMutationResponse(raw)) {
        capture.transition.fail();
        return;
      }
      const { mutation, identity, startingItem } = capture;
      const item =
        mutation.action === "save"
          ? startingItem ?? snapshotFor(mutation.videoId)
          : undefined;
      const confirmed = capture.transition.confirm(() =>
        send({
          action: "bookmark",
          bookmarkAction: mutation.action,
          externalId: mutation.videoId,
          canonicalUrl: item?.url ?? `https://www.tiktok.com/video/${mutation.videoId}`,
          ...identity,
          ...(item ? { normalizedItem: item } : {}),
        }),
      );
      if (!confirmed) recoverMutation(capture, recover, true);
    };

    const RESPONSE_OBSERVATION_TIMEOUT_MS = 15_000;
    const readResponseJson = (response: Response) => {
      let json: Promise<unknown>;
      try {
        json = response.clone().json().catch(() => null);
      } catch {
        json = Promise.resolve(null);
      }
      const observation = new Promise<
        { timedOut: true } | { timedOut: false; raw: unknown }
      >((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), RESPONSE_OBSERVATION_TIMEOUT_MS);
        json.then((raw) => {
          clearTimeout(timer);
          resolve({ timedOut: false, raw });
        });
      });
      return { observation, json };
    };

    const nativeFetch = window.fetch;
    const patched = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const input = args[0];
      let url = "";
      try {
        url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      } catch {
        // The native request still receives the original arguments below.
      }
      const requestConfig = mutationConfig;
      const mutationRequest = isMutationEndpoint(url, requestConfig);
      let initBody: BodyInit | null | undefined;
      try {
        initBody = args[1]?.body;
      } catch {
        // Observation is best effort and must not preempt the native fetch.
      }
      const identity = mutationRequest
        ? { mutationId: crypto.randomUUID(), observedAt: Math.floor(Date.now() / 1000) }
        : null;
      const reservation = mutationRequest ? transitions.reserve() : null;
      let requestFailed = false;
      let identityUnavailable = false;
      let recoverySent = false;
      const recoverWithoutCapture = (force = false) => {
        if (recoverySent && !force) return;
        recoverySent = true;
        send({ action: "saved" });
      };
      let requestBody: Promise<string | null> | null = null;
      if (mutationRequest && initBody === undefined && input instanceof Request) {
        try {
          requestBody = input.clone().text().catch(() => null);
        } catch {
          identityUnavailable = true;
          requestBody = Promise.resolve(null);
        }
      }
      const identityExpired = reservation?.expired.then(() => {
        identityUnavailable = true;
      });
      let bodyCapture: Promise<MutationCapture | null> | null = null;
      if (requestBody && identity && reservation) {
        bodyCapture = requestBody.then((body) => {
          if (body === null) identityUnavailable = true;
          return captureMutation(url, body, identity, reservation, () => requestFailed, requestConfig);
        });
      }
      const capturePromise =
        mutationRequest && identity && reservation
          ? bodyCapture && identityExpired
            ? Promise.race([bodyCapture, identityExpired.then(() => null)])
            : Promise.resolve(
                captureMutation(url, initBody, identity, reservation, () => requestFailed, requestConfig),
              )
          : null;
      let responsePromise: Promise<Response>;
      try {
        responsePromise = nativeFetch.apply(this, args);
      } catch (error) {
        requestFailed = true;
        reservation?.skip();
        void capturePromise?.then((capture) => capture?.transition.fail());
        throw error;
      }
      let res: Response;
      try {
        res = await responsePromise;
      } catch (error) {
        requestFailed = true;
        reservation?.skip();
        void capturePromise?.then((capture) => capture?.transition.fail());
        throw error;
      }
      try {
        const operation = matchUrl(url);
        if (operation) {
          res.clone().json().then((raw) => forward(operation, raw)).catch(() => {});
        }
        if (mutationRequest && capturePromise) {
          if (!res.ok) {
            void capturePromise.then((capture) => capture?.transition.fail());
          } else {
            const responseJson = readResponseJson(res);
            void Promise.all([responseJson.observation, capturePromise])
              .then(([observation, capture]) => {
                if (observation.timedOut) {
                  capture?.transition.fail();
                  recoverMutation(capture, recoverWithoutCapture);
                  void responseJson.json.then((raw) => {
                    if (isSuccessfulMutationResponse(raw)) {
                      recoverMutation(capture, recoverWithoutCapture, true);
                    }
                  });
                  return;
                }
                forwardMutation(capture, observation.raw, identityUnavailable, recoverWithoutCapture);
              })
              .catch(() => {});
          }
        }
      } catch {
        if (mutationRequest && capturePromise) {
          void capturePromise.then((capture) => capture?.transition.fail());
        }
        // Observation must never break the page.
      }
      return res;
    };
    window.fetch = Object.assign(patched, nativeFetch) as typeof fetch;

    const nativeOpen = XMLHttpRequest.prototype.open;
    const requestUrls = new WeakMap<XMLHttpRequest, string>();
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        requestUrls.set(this, String(url));
        const operation = matchUrl(String(url));
        if (operation) {
          this.addEventListener("load", () => {
            try {
              forward(operation, xhrResponseJson(this));
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
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const url = requestUrls.get(this);
      const requestConfig = mutationConfig;
      const mutationRequest = !!url && isMutationEndpoint(url, requestConfig);
      const identity = mutationRequest
        ? { mutationId: crypto.randomUUID(), observedAt: Math.floor(Date.now() / 1000) }
        : null;
      const reservation = mutationRequest ? transitions.reserve() : null;
      const capture =
        mutationRequest && url && identity && reservation
          ? captureMutation(url, body, identity, reservation, () => false, requestConfig)
          : null;
      if (mutationRequest && capture) {
        try {
          this.addEventListener("load", () => {
            if (this.status < 200 || this.status >= 300) {
              capture.transition.fail();
              return;
            }
            try {
              forwardMutation(capture, xhrResponseJson(this));
            } catch {
              capture.transition.fail();
            }
          }, { once: true });
          for (const eventName of ["error", "abort", "timeout"] as const) {
            this.addEventListener(eventName, () => capture.transition.fail(), {
              once: true,
            });
          }
        } catch {
          capture.transition.fail();
        }
      }
      try {
        return nativeSend.call(this, body);
      } catch (error) {
        capture?.transition.fail();
        throw error;
      }
    };

    // ---- who is signed in --------------------------------------------------

    /**
     * The handle, from the blob TikTok rehydrates its app with.
     *
     * It is written into the document by the server, so at document_start it
     * may not be there yet; this waits for it rather than reporting a
     * signed-out state that is only early.
     */
    const identify = async (): Promise<{ handle: string | null; signedOut: boolean }> => {
      const deadline = Date.now() + 10_000;
      let checkedAccount = false;
      for (;;) {
        const scope =
          (window as unknown as { __UNIVERSAL_DATA_FOR_REHYDRATION__?: unknown })
            .__UNIVERSAL_DATA_FOR_REHYDRATION__ ??
          (window as unknown as { SIGI_STATE?: unknown }).SIGI_STATE ??
          (() => {
            const text = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent;
            if (!text) return null;
            try { return JSON.parse(text) as unknown; } catch { return null; }
          })();
        const handle = readHandle(scope);
        if (handle) return { handle, signedOut: false };
		const profileHref = document
			.querySelector<HTMLAnchorElement>('a[data-e2e="nav-profile"][href]')
			?.getAttribute("href");
		const profileHandle = readHandleFromProfileHref(profileHref);
		if (profileHandle) return { handle: profileHandle, signedOut: false };
        if (!checkedAccount && document.readyState !== "loading") {
          checkedAccount = true;
          try {
            const response = await fetch("/passport/web/account/info/?aid=1988&app_language=en&app_name=tiktok_web", {
              credentials: "include",
              signal: AbortSignal.timeout(6_000),
            });
            if (response.ok) {
              const account = readAccountInfo(await response.json());
              if (account.handle || account.signedOut) return account;
            }
          } catch { /* TikTok may block this request; keep checking page state. */ }
        }
        if (Date.now() >= deadline) return { handle: null, signedOut: false };
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    // ---- the scan ----------------------------------------------------------

    /**
     * There is no body yet.
     *
     * This runs at document_start — not optional, since patching fetch after
     * the app has cached its own reference patches nothing — and a scan can be
     * commanded while the tab is still navigating. `document.body` is null
     * until the parser reaches it, and reading scrollHeight off null throws.
     */
    const waitForBody = async (timeoutMs = 15_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (!document.body) {
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return true;
    };

    /** documentElement exists from the first byte; body does not. */
    const pageHeight = (): number =>
      document.body?.scrollHeight ?? document.documentElement?.scrollHeight ?? 0;

    const clickFavouritesTab = async (): Promise<boolean> => {
      const deadline = Date.now() + 8_000;
      for (;;) {
        for (const selector of FAVOURITES_TAB_SELECTORS) {
          const tab = document.querySelector<HTMLElement>(selector);
          if (tab) {
            tab.click();
            // Let the tab swap its list before anything scrolls it.
            await new Promise((r) => setTimeout(r, 1_200));
            return true;
          }
        }
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    /**
     * Load the rest of the list.
     *
     * TikTok fetches as the page grows, and the patch above keeps what comes
     * back, so scrolling is the whole import. It ends when a Favourites
     * response says there is no more — a real answer — and falls back to the
     * page having stopped growing, which is what "no more" looks like from out
     * here when nothing said so.
     */
    const scan = async () => {
      let stalled = 0;
      for (let step = 0; step < 400 && stalled < 4 && moreToLoad; step++) {
        const before = pageHeight();
        window.scrollTo({ top: before, behavior: "auto" });
        await new Promise((r) => setTimeout(r, 1_200));
        stalled = pageHeight() > before ? 0 : stalled + 1;
      }
    };

    // ---- commands from the relay ------------------------------------------

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        anansi?: string;
        action?: string;
        config?: ScanConfig;
        messageVersion?: number;
        nonce?: string;
        runId?: string;
      };
      if (
        msg?.anansi !== "page-command" ||
        msg.messageVersion !== MESSAGE_PROTOCOL_VERSION ||
        typeof msg.nonce !== "string" ||
        msg.config?.source !== "tiktok"
      ) {
        return;
      }

      if (msg.action === "configure") {
        nonce = msg.nonce;
        for (const event of waiting.splice(0)) send(event);
        activeRunId = typeof msg.runId === "string" ? msg.runId : null;
        watched = msg.config.watchUrls ?? [];
        mutationConfig = msg.config;
      }

      if (msg.action === "identify" && msg.nonce === nonce) {
        void (async () => {
          const account = await identify();
          if (account.handle && activeRunId) send({ action: "identified", handle: account.handle, runId: activeRunId });
          else if (activeRunId) send({ action: "error", errorCode: account.signedOut ? "not_signed_in" : "capture_failed", runId: activeRunId });
        })();
      }

      if (msg.action === "scan" && msg.nonce === nonce) {
        if (scanning) return;
        scanning = true;
        moreToLoad = true;
        sawFavoritesResponse = false;
        void (async () => {
          /**
           * Whatever happens, say so and let the next run start.
           *
           * Without the finally, one thrown error left `scanning` true for the
           * life of the page: every later Import returned early, and the
           * background never heard "scanned", so the run sat there until it
           * timed out. One exception became a permanently dead tab — which is
           * what "TikTok worked once and then stopped" actually was.
           */
          try {
            if (!(await waitForBody())) {
              if (activeRunId) send({ action: "error", errorCode: "capture_failed", runId: activeRunId });
              return;
            }
            if (!(await clickFavouritesTab())) {
              if (activeRunId) send({ action: "error", errorCode: "capture_failed", runId: activeRunId });
              return;
            }
            await scan();
            if (sawFavoritesResponse && !moreToLoad && activeRunId) send({ action: "scanned", runId: activeRunId });
            else if (activeRunId) send({ action: "error", errorCode: "capture_failed", runId: activeRunId });
          } catch {
            if (activeRunId) send({ action: "error", errorCode: "capture_failed", runId: activeRunId });
          } finally {
            scanning = false;
          }
        })();
      }
    });
  },
});
