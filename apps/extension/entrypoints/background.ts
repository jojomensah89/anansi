/**
 * The background worker: the only part of the extension that knows a server
 * exists, and the only part that holds the token.
 *
 * The thin pipe in one place — fetch a config, hand the right piece of it to
 * the right tab, upload whatever comes back untouched. There is no parsing
 * here on purpose: when a platform reshapes a response the fix ships
 * server-side and every install is repaired on its next run, which is what
 * makes distributing this load-unpacked reasonable rather than a maintenance
 * trap.
 */

import {
  cachedForServer,
  normalizeServerOrigin,
  type ServerCache,
} from "../lib/config-cache.ts";
import {
  createCaptureQueue,
  type CaptureQueue,
} from "../lib/capture-queue.ts";
import {
  createIndexedDbOutbox,
  type IndexedDbOutbox,
} from "../lib/idb-outbox.ts";
import { createIngestTransport } from "../lib/ingest-transport.ts";
import {
  MESSAGE_PROTOCOL_VERSION,
  parseExtensionMessage,
  type PageEventMessage,
  type PlatformSource,
  type PopupCommandMessage,
} from "../lib/messages.ts";
import {
  captureDeliveryMode,
  createSourceRuns,
  isExpectedImportTab,
  type CaptureSource,
  type SourceRuns,
} from "../lib/source-runs.ts";
import {
  capturablePage,
  readPage,
  toWebCapture,
  UNSUPPORTED_MESSAGES,
  type PageDetails,
} from "../lib/page-capture.ts";
import { isProfileView, profileUrl } from "../lib/platforms/tiktok.ts";
import { tweetUrl } from "../lib/platforms/x.ts";
import type {
  CaptureQueueStatus,
  ItemEventCapture,
  RawPageCapture,
} from "@anansi/sources";

export interface Settings {
  server: string;
  token: string;
  /** Minutes between automatic syncs. 0 disables them. */
  syncEvery: number;
}

export interface SourceConfig {
  source: string;
  host: string;
  mode: "page" | "observe";
  operation?: string;
  url?: string;
  variables?: Record<string, unknown>;
  cursorPrefix?: string;
  cursorParam?: string;
  cursorPath?: string;
  entryPrefix?: string;
  pageLimit?: number;
  watchOperations?: string[];
  watchUrls?: string[];
}

export interface RemoteConfig {
  version: number;
  enabled: boolean;
  ingest: string;
  ingestProtocolVersion?: number;
  features?: {
    captureV2?: Partial<Record<"x" | "reddit" | "tiktok" | "web", boolean>>;
    chromeBookmarks?: boolean;
  };
  sources: SourceConfig[];
}

export interface SourceStatus {
  /**
   * When the current run began, or null when nothing is running.
   *
   * The popup decides staleness from this rather than trusting a timer here:
   * MV3 kills an idle service worker after about thirty seconds, so a
   * setTimeout watchdog in this file usually never fires — which is exactly
   * how "running…" got written to storage and stayed there forever.
   */
  startedAt: number | null;
  lastRun: number | null;
  pages: number;
  items: number;
  uploaded: number;
  failed: number;
  message: string | null;
}

export type Status = Record<string, SourceStatus>;

const CONFIG_TTL_MS = 60 * 60 * 1000;
const ALARM = "anansi-sync";
const OUTBOX_ALARM = "anansi-outbox";
const CAPTURE_SOURCES = ["x", "reddit", "tiktok"] as const;
const tabNonces = new Map<number, string>();

let cached: ServerCache<RemoteConfig> | null = null;
let persistent: { outbox: IndexedDbOutbox; runs: SourceRuns } | null = null;
let durableQueue: CaptureQueue | null = null;

function persistentState(): { outbox: IndexedDbOutbox; runs: SourceRuns } {
  if (persistent) return persistent;
  const outbox = createIndexedDbOutbox();
  persistent = {
    outbox,
    runs: createSourceRuns({
      store: outbox,
      now: Date.now,
      createId: () => crypto.randomUUID(),
    }),
  };
  return persistent;
}

async function settings(): Promise<Settings | null> {
  const stored = await browser.storage.local.get(["server", "token", "syncEvery"]);
  const server = normalizeServerOrigin(String(stored.server ?? ""));
  const token = String(stored.token ?? "");
  const syncEvery = Number(stored.syncEvery ?? 0);
  return server && token ? { server, token, syncEvery } : null;
}

async function patchStatus(source: string, patch: Partial<SourceStatus>): Promise<void> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  const current = all[source] ?? { startedAt: null, lastRun: null, pages: 0, items: 0, uploaded: 0, failed: 0, message: null };
  await browser.storage.local.set({ status: { ...all, [source]: { ...current, ...patch } } });
}

async function readStatus(source: string): Promise<SourceStatus> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  return all[source] ?? { startedAt: null, lastRun: null, pages: 0, items: 0, uploaded: 0, failed: 0, message: null };
}

/**
 * Revalidated hourly rather than fetched per run, and the kill switch: a
 * source switched off in the web app simply stops appearing here, so capture
 * for it stops on the next run without anyone updating anything.
 */
async function loadConfig(force = false): Promise<RemoteConfig | null> {
  const s = await settings();
  if (!s) return null;
  const now = Date.now();
  const fresh = cachedForServer(cached, s.server, now, CONFIG_TTL_MS);
  if (!force && fresh) return fresh;

  const url = `${s.server}/api/extension/config`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      throw new Error(`404 at ${url} — is an older Anansi server still on that port?`);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    const config = (await res.json()) as RemoteConfig;
    if (!Array.isArray(config.sources)) throw new Error(`unexpected config shape from ${url}`);
    cached = { serverOrigin: s.server, at: Date.now(), value: config };
    return config;
  } catch (err) {
    await patchStatus("_", { message: (err as Error).message });
    return cachedForServer(cached, s.server, Date.now(), CONFIG_TTL_MS, true);
  }
}

function isCaptureSource(source: string): source is CaptureSource {
  return CAPTURE_SOURCES.includes(source as (typeof CAPTURE_SOURCES)[number]);
}

function queue(): CaptureQueue {
  if (durableQueue) return durableQueue;
  const { outbox } = persistentState();
  durableQueue = createCaptureQueue({
    store: outbox,
    transport: createIngestTransport(async () => {
      const [s, config] = await Promise.all([settings(), loadConfig()]);
      return s && config ? { ingest: config.ingest, token: s.token } : null;
    }),
    clock: { now: Date.now },
    random: Math.random,
    scheduler: {
      schedule(at) {
        browser.alarms.create(OUTBOX_ALARM, { when: Math.max(Date.now() + 100, at) });
      },
    },
  });
  return durableQueue;
}

/**
 * Counts, read at the moment they are asked for.
 *
 * There is deliberately no cached copy in storage any more. A second place to
 * look is a second thing that can be stale, and a stale count is exactly the
 * failure this whole pass exists to remove.
 */
function publishQueueStatus(): Promise<CaptureQueueStatus> {
  return queue().getStatus();
}

async function wakeDurableQueue(
  includeFailed = false,
  source?: CaptureSource,
): Promise<CaptureQueueStatus> {
  return queue().retry(
    includeFailed ? { includeFailed: true, ...(source ? { source } : {}) } : undefined,
  );
}

/** Legacy direct upload, kept only while a source's captureV2 flag is off. */
async function legacyUpload(source: string, raw: unknown): Promise<void> {
  const [s, config] = await Promise.all([settings(), loadConfig()]);
  if (!s || !config) return;

  try {
    const res = await fetch(config.ingest, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ source, raw }),
    });
    const current = await readStatus(source);
    if (res.ok) {
      await patchStatus(source, { uploaded: current.uploaded + 1, message: null });
    } else {
      // 422 is the server's zero-parse alarm. It means the payload shape
      // changed, and it must be visible rather than swallowed.
      const body = await res.text().catch(() => "");
      // A 422 carries the shape the server could not parse. Keep more of it
      // than a normal error, because it is the whole diagnosis.
      await patchStatus(source, {
        failed: current.failed + 1,
        message: `ingest ${res.status}: ${body.slice(0, res.status === 422 ? 600 : 120)}`,
      });
    }
  } catch (err) {
    const current = await readStatus(source);
    await patchStatus(source, { failed: current.failed + 1, message: (err as Error).message });
  }
}

/** Exactly one delivery path owns a payload, selected by its source flag. */
async function deliverRaw(
  source: CaptureSource,
  raw: unknown,
  requestedPage?: number,
  cursor?: string | null,
): Promise<void> {
  const config = await loadConfig();
  const delivery = captureDeliveryMode(
    config?.ingestProtocolVersion,
    config?.features?.captureV2,
    source,
  );
  if (delivery === "legacy") {
    await legacyUpload(source, raw);
    return;
  }

  const { outbox, runs } = persistentState();
  const identity = await runs.capturePage(source, requestedPage);
  const capture: RawPageCapture = {
    schemaVersion: 1,
    payloadType: "raw_page",
    eventId: identity.eventId,
    source,
    action: "snapshot",
    observedAt: Math.floor(Date.now() / 1000),
    captureMethod: "platform_import",
    runId: identity.runId,
    page: identity.page,
    ...(cursor ? { cursor } : {}),
    raw,
  };
  const enqueued = await queue().enqueue(capture);
  // Only now: a cursor that moves before its page is durable is how an
  // interrupted import silently skips everything it had not yet sent.
  if (cursor !== undefined) await runs.setCursor(source, cursor);
  await wakeDurableQueue();

  const [pending, current] = await Promise.all([
    outbox.get(enqueued.eventId),
    readStatus(source),
  ]);
  if (!pending) {
    await patchStatus(source, { uploaded: current.uploaded + 1, message: null });
  } else if (pending.state === "failed") {
    await patchStatus(source, {
      failed: current.failed + 1,
      message: pending.lastError?.message ?? "capture delivery failed",
    });
  } else {
    await patchStatus(source, { message: "saved locally; delivery will retry" });
  }
}

/**
 * Deliver one precise save or unsave.
 *
 * The event id is derived rather than random on purpose: X fires some
 * mutations through both fetch and XHR, so the same click can be observed
 * twice, and two events with one id are one event.
 */
async function deliverItemEvent(
  source: CaptureSource,
  action: "save" | "unsave",
  externalId: string,
  canonicalUrl?: string,
): Promise<void> {
  const config = await loadConfig();
  const delivery = captureDeliveryMode(
    config?.ingestProtocolVersion,
    config?.features?.captureV2,
    source,
  );
  // Legacy delivery has no way to say "this one item changed"; the refresh it
  // already schedules is the only thing it can do.
  if (delivery === "legacy") return;

  const observedAt = Math.floor(Date.now() / 1000);
  const capture: ItemEventCapture = {
    schemaVersion: 1,
    payloadType: "item_event",
    eventId: `${source}:${action}:${externalId}:${observedAt}`,
    source,
    action,
    observedAt,
    captureMethod: "platform_event",
    externalId,
    canonicalUrl: canonicalUrl ?? tweetUrl(externalId),
  };
  await queue().enqueue(capture);
  await wakeDurableQueue();
}

/**
 * A save arrives before its content does.
 *
 * X answers CreateBookmark with "Done" and nothing else, so the id is held
 * until a refresh has queued the timeline page that carries the post. An
 * unsave needs no content and goes out immediately.
 */
async function handleBookmarkMutation(
  source: CaptureSource,
  action: "save" | "unsave",
  externalId: string,
  canonicalUrl?: string,
  raw?: unknown,
): Promise<void> {
  const runs = persistentState().runs;

  // Reddit can look the object up and send it along, so content and event
  // arrive together. The queue is serial per source, so enqueuing the page
  // first is what guarantees the item exists before the event lands on it.
  if (raw !== undefined) {
    await deliverRaw(source, raw);
    await deliverItemEvent(source, action, externalId, canonicalUrl);
    await patchStatus(source, { lastRun: Date.now() });
    return;
  }

  if (action === "unsave") {
    await deliverItemEvent(source, "unsave", externalId, canonicalUrl);
    await patchStatus(source, { lastRun: Date.now() });
    return;
  }
  await runs.recordPendingSave(source, externalId);
  await runs.requestRefresh(source);
  browser.alarms.create(OUTBOX_ALARM, { when: Date.now() + 2_500 });
}

/** Send the held saves now that the pages carrying their content are queued. */
async function flushPendingSaves(source: CaptureSource): Promise<void> {
  const pending = await persistentState().runs.takePendingSaves(source);
  for (const externalId of pending) {
    await deliverItemEvent(source, "save", externalId);
  }
}

/**
 * Save the page in one tab, right now.
 *
 * `activeTab` is what makes this possible without host permission for every
 * site, and it is also why this only ever runs from a deliberate gesture: the
 * grant arrives when you press the button or the menu item and lapses after.
 * There is no path here that reads a page you did not ask for.
 */
async function capturePage(
  tabId: number,
  method: "toolbar" | "context_menu",
  selectionText?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const supported = capturablePage(tab?.url);
  if (!supported.ok) {
    await patchStatus("web", { message: UNSUPPORTED_MESSAGES[supported.reason] });
    return { ok: false, error: UNSUPPORTED_MESSAGES[supported.reason] };
  }

  let details: PageDetails;
  try {
    const [injected] = await browser.scripting.executeScript({
      target: { tabId },
      func: readPage,
    });
    details = injected?.result as PageDetails;
    if (!details?.url) throw new Error("nothing came back");
  } catch {
    const message = "could not read that page";
    await patchStatus("web", { message });
    return { ok: false, error: message };
  }

  // The menu passes what was highlighted; it is more reliable than asking the
  // page again, because the click can clear the selection.
  const built = await toWebCapture(
    { ...details, selection: selectionText ?? details.selection },
    { method, observedAt: Math.floor(Date.now() / 1000) },
  );
  if (!built.ok) {
    await patchStatus("web", { message: UNSUPPORTED_MESSAGES[built.reason] });
    return { ok: false, error: UNSUPPORTED_MESSAGES[built.reason] };
  }

  await queue().enqueue(built.capture);
  await wakeDurableQueue();

  const pending = await persistentState().outbox.get(built.capture.eventId);
  const current = await readStatus("web");
  await patchStatus("web", {
    lastRun: Date.now(),
    items: current.items + 1,
    ...(pending
      ? { message: "saved locally; delivery will retry" }
      : { uploaded: current.uploaded + 1, message: null }),
  });
  return { ok: true };
}

type MenuSpec = Parameters<typeof browser.contextMenus.create>[0];

const MENUS: MenuSpec[] = [
  { id: "anansi-save-page", title: "Save page to Anansi", contexts: ["page"] },
  { id: "anansi-save-selection", title: "Save selection to Anansi", contexts: ["selection"] },
];

/** Where to open a tab when there isn't one, per source. */
const ENTRY_URLS: Record<string, string> = {
  x: "https://x.com/i/bookmarks",
  reddit: "https://www.reddit.com/user/me/saved/",
  tiktok: "https://www.tiktok.com/",
};

const HOST_PATTERNS: Record<string, string[]> = {
  x: ["https://x.com/*", "https://twitter.com/*"],
  reddit: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  tiktok: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
};

async function findTab(source: string) {
  const patterns = HOST_PATTERNS[source];
  if (!patterns) return undefined;
  const tabs = await browser.tabs.query({ url: patterns });
  return tabs.find((tab) => tab.url && isExpectedImportTab(source as CaptureSource, tab.url));
}

/**
 * Open a tab for a source and wait for its content scripts.
 *
 * Opened inactive, so an import does not yank you out of what you were doing,
 * and closed again afterwards if we were the ones who opened it.
 */
async function openTab(source: string): Promise<{ id: number; ours: boolean } | null> {
  // Once TikTok has told us who you are, later runs skip the front page and
  // open your own profile, which is where favourites live.
  const known =
    source === "tiktok"
      ? (await persistentState().runs.current("tiktok")).handle
      : undefined;
  const url = (known ? profileUrl(known) : null) ?? ENTRY_URLS[source];
  if (!url) return null;
  const tab = await browser.tabs.create({ url, active: false });
  if (!tab.id) return null;

  const id = tab.id;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 25_000);
    function finish() {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      // document_idle scripts land a beat after "complete".
      setTimeout(resolve, 900);
    }
    function onUpdated(tabId: number, info: { status?: string }) {
      if (tabId === id && info.status === "complete") finish();
    }
    browser.tabs.onUpdated.addListener(onUpdated);
  });

  return { id, ours: true };
}

/**
 * Wait for the page to say who is signed in.
 *
 * The answer arrives as an ordinary page event rather than a reply, because
 * MAIN-world code reaches the background only through the relay. So this polls
 * the durable state the handler writes, which has the useful side effect of
 * working even if the worker was restarted in between.
 */
async function waitForHandle(
  source: CaptureSource,
  timeoutMs: number,
): Promise<string | null> {
  const runs = persistentState().runs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await runs.current(source);
    if (state.handle) return state.handle;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Send a tab somewhere and wait for it to finish arriving. */
async function navigateTab(tabId: number, url: string): Promise<void> {
  await browser.tabs.update(tabId, { url }).catch(() => {});
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 25_000);
    function finish() {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      // document_idle scripts land a beat after "complete".
      setTimeout(resolve, 900);
    }
    function onUpdated(updatedId: number, info: { status?: string }) {
      if (updatedId === tabId && info.status === "complete") finish();
    }
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

async function closeOwnedTab(source: CaptureSource, expectedTabId?: number): Promise<void> {
  const tabId = await persistentState().runs.takeOwnedTab(source, expectedTabId);
  if (tabId !== null) await browser.tabs.remove(tabId).catch(() => {});
}

async function finishRun(source: CaptureSource): Promise<void> {
  await persistentState().runs.finish(source);
  await closeOwnedTab(source);
}

async function expireOwnedRun(source: CaptureSource, expectedTabId: number): Promise<void> {
  const runs = persistentState().runs;
  const tabId = await runs.takeOwnedTab(source, expectedTabId);
  if (tabId === null) return;
  await runs.finish(source);
  await browser.tabs.remove(tabId).catch(() => {});
  await patchStatus(source, {
    startedAt: null,
    message: "capture timed out; retry when the platform is ready",
  });
}

/**
 * Capture runs in a browser tab, using the session it already has — never
 * from the background worker, which would mean taking the `cookies`
 * permission to rebuild a session the page is already holding.
 *
 * It no longer has to be a tab YOU opened, though. If none is open the
 * extension opens one in the background and closes it when the run is done,
 * so importing does not depend on you being on the site.
 */
async function startCapture(source: string, quiet = false, live = false): Promise<void> {
  if (!isCaptureSource(source)) return;
  const runs = persistentState().runs;
  const begun = await runs.begin(source);
  if (!begun.started) {
    if (!quiet) await patchStatus(source, { message: "a capture is already running" });
    return;
  }

  const config = await loadConfig(true);
  if (!config?.enabled) {
    if (!quiet) await patchStatus(source, { message: "server has capture disabled" });
    await runs.finish(source);
    return;
  }

  const entry = config.sources.find((s) => s.source === source);
  if (!entry) {
    if (!quiet) await patchStatus(source, { message: "switched off in Sources" });
    await runs.finish(source);
    return;
  }

  let target: { id: number; ours: boolean } | null = null;
  const existing = await findTab(source);
  if (existing?.id) target = { id: existing.id, ours: false };
  else {
    await patchStatus(source, { message: `opening ${entry.host}…` });
    target = await openTab(source);
  }

  if (!target) {
    await runs.finish(source);
    await patchStatus(source, { startedAt: null, message: `could not open ${entry.host}` });
    return;
  }
  const tab = { id: target.id };
  if (target.ours) await runs.setOwnedTab(source, tab.id);

  if (entry.mode === "observe") {
    const configure = () =>
      talk(tab.id, {
        anansi: "page-command",
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source,
        action: "configure",
        config: entry,
      });

    if (!(await configure())) {
      await finishRun(source);
      await patchStatus(source, {
        startedAt: null,
        message: `could not reach the ${entry.host} tab`,
      });
      return;
    }

    /**
     * Find the favourites, rather than asking you to.
     *
     * The page reports the signed-in handle, and the tab goes to that
     * profile — which is the difference between "press Import" and "press
     * Import, then scroll your favourites yourself". The handle is
     * remembered, so every later run opens the right place immediately.
     */
    if (source === "tiktok") {
      await patchStatus(source, { message: "finding your favourites…" });
      await talk(tab.id, {
        anansi: "page-command",
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source,
        action: "identify",
        config: entry,
      });

      const handle = await waitForHandle(source, 12_000);
      if (!handle) {
        await finishRun(source);
        await patchStatus(source, {
          startedAt: null,
          message: `sign in to ${entry.host}, then press Import`,
        });
        return;
      }

      const current = await browser.tabs.get(tab.id).catch(() => null);
      const destination = profileUrl(handle);
      if (destination && !(current?.url && isProfileView(current.url, handle))) {
        await navigateTab(tab.id, destination);
        if (!(await configure())) {
          await finishRun(source);
          await patchStatus(source, {
            startedAt: null,
            message: `could not reach the ${entry.host} tab`,
          });
          return;
        }
      }
    }
    // Nothing to request, so the capture is a scroll: the app fetches its own
    // item lists as the page grows, and those are what get kept.
    await patchStatus(source, {
      startedAt: begun.run.startedAt,
      pages: 0,
      uploaded: 0,
      failed: 0,
      message: "scanning…",
    });
    const scanning = await talk(tab.id, {
      anansi: "page-command",
      messageVersion: MESSAGE_PROTOCOL_VERSION,
      source,
      action: "scan",
      config: entry,
    });
    if (!scanning) {
      await finishRun(source);
      await patchStatus(source, {
        startedAt: null,
        message: `could not start the ${entry.host} scan`,
      });
      return;
    }
    if (target.ours) {
      setTimeout(() => void expireOwnedRun(source, tab.id), 90_000);
    }
    return;
  }

  /**
   * A live sync is one small page, not a whole run. The thing you just saved
   * is at the top of the listing, so twenty items reaches it with room to
   * spare — and the upsert makes the nineteen you already have free.
   */
  const job = live
    ? { ...entry, pageLimit: 1, variables: { ...(entry.variables ?? {}), count: 20 } }
    : // A full run picks up where the last acknowledged page left off, so an
      // import interrupted at page nine does not start again at page one.
      { ...entry, ...(begun.run.cursor ? { resumeCursor: begun.run.cursor } : {}) };
  await patchStatus(source, {
    startedAt: begun.run.startedAt,
    pages: 0,
    items: 0,
    uploaded: 0,
    failed: 0,
    message: "running…",
  });
  const reached =
    (await talk(tab.id, {
      anansi: "page-command",
      messageVersion: MESSAGE_PROTOCOL_VERSION,
      source,
      action: "configure",
      config: job,
    })) &&
    (await talk(tab.id, {
      anansi: "page-command",
      messageVersion: MESSAGE_PROTOCOL_VERSION,
      source,
      action: "backfill",
      config: job,
    }));

  if (!reached) {
    await finishRun(source);
    await patchStatus(source, {
      startedAt: null,
      message: `could not reach the ${entry.host} tab; reload it and try again`,
    });
    return;
  }

  // Close a tab we opened once the run reports in, or after a ceiling.
  if (target.ours) {
    setTimeout(() => void expireOwnedRun(source, tab.id), 180_000);
  }
}

/**
 * Talk to a tab, reloading it once if nobody is listening.
 *
 * Content scripts are injected when a page loads, so a tab that was already
 * open when the extension was installed or reloaded has none — and
 * `sendMessage` rejects with "Receiving end does not exist". Swallowing that
 * is what left the popup saying "running…" forever with no way to tell why.
 *
 * A reload puts the script in place. It is the user's own tab, on the site
 * they just asked to import from, in response to their click.
 */
async function talk(tabId: number, message: unknown): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // Nobody home. Reload and wait for the script to land.
  }

  try {
    await browser.tabs.reload(tabId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tab reload timed out")), 20_000);
      const onUpdated = (id: number, info: { status?: string }) => {
        if (id !== tabId || info.status !== "complete") return;
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(onUpdated);
        // document_idle scripts land a beat after "complete".
        setTimeout(resolve, 600);
      };
      browser.tabs.onUpdated.addListener(onUpdated);
    });
    await browser.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function rescheduleAlarm(): Promise<void> {
  await browser.alarms.clear(ALARM);
  const s = await settings();
  const minutes = s?.syncEvery ?? 0;
  if (minutes > 0) {
    browser.alarms.create(ALARM, { periodInMinutes: minutes, delayInMinutes: minutes });
  }
}

async function processPendingRefreshes(): Promise<void> {
  const runs = persistentState().runs;
  for (const source of CAPTURE_SOURCES) {
    if (await runs.claimRefresh(source)) await startCapture(source, true, true);
  }
}

const EMPTY_COUNTS: CaptureQueueStatus = {
  queued: 0,
  uploading: 0,
  retrying: 0,
  failed: 0,
};

/**
 * Outbox counts split by source.
 *
 * The popup needs these per row, not just as a grand total: "1,274 saved" next
 * to a row that still has three captures it could not send is the kind of
 * reassurance that made the old popup untrustworthy.
 */
async function queueBySource(): Promise<Record<string, CaptureQueueStatus>> {
  const records = await persistentState().outbox.list();
  const counts: Record<string, CaptureQueueStatus> = {};
  for (const source of CAPTURE_SOURCES) counts[source] = { ...EMPTY_COUNTS };
  for (const record of records) {
    const bucket = (counts[record.source] ??= { ...EMPTY_COUNTS });
    if (record.state === "queued") bucket.queued++;
    else if (record.state === "uploading") bucket.uploading++;
    else if (record.state === "retry_wait") bucket.retrying++;
    else bucket.failed++;
  }
  return counts;
}

async function durableSnapshot() {
  const runsState = persistentState().runs;
  const [queueStatus, bySource, ...runs] = await Promise.all([
    publishQueueStatus(),
    queueBySource(),
    ...CAPTURE_SOURCES.map((source) => runsState.current(source)),
  ]);
  return {
    queue: queueStatus,
    bySource,
    runs: Object.fromEntries(runs.map((run) => [run.source, run])),
  };
}

type BackgroundResult =
  | { ok: true; snapshot?: Awaited<ReturnType<typeof durableSnapshot>> }
  | { ok: false; error: string };

interface RuntimeMessageSender {
  url?: string;
  tab?: { id?: number; url?: string };
}

function claimedNonce(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const descriptor = Object.getOwnPropertyDescriptor(value, "nonce");
  return typeof descriptor?.value === "string" ? descriptor.value : "";
}

function validateRuntimeMessage(message: unknown, sender: RuntimeMessageSender) {
  if (!sender.tab) {
    return parseExtensionMessage(message, {
      path: "runtime-to-background",
      sender: { kind: "extension" },
    });
  }

  const tabId = sender.tab.id;
  const senderUrl = sender.url ?? sender.tab.url ?? "";
  if (!Number.isSafeInteger(tabId)) {
    return parseExtensionMessage(message, {
      path: "runtime-to-background",
      sender: { kind: "tab", url: senderUrl },
      expectedNonce: "",
    });
  }

  // On a service-worker restart the map is empty. The first event can seed it
  // because only our isolated-world relay can call runtime.sendMessage; the
  // page itself can only reach that relay, which already checked the nonce.
  const expectedNonce = tabNonces.get(tabId as number) ?? claimedNonce(message);
  const parsed = parseExtensionMessage(message, {
    path: "runtime-to-background",
    sender: { kind: "tab", url: senderUrl },
    expectedNonce,
  });
  if (parsed.ok) tabNonces.set(tabId as number, expectedNonce);
  return parsed;
}

type PlatformErrorCode = Extract<PageEventMessage, { action: "error" }>["errorCode"];

const SAFE_PLATFORM_ERRORS: Record<PlatformErrorCode, string> = {
  platform_request_failed: "the platform request failed; retry after checking the signed-in tab",
  not_signed_in: "the platform tab is not signed in",
  query_unavailable: "the bookmark query is unavailable; open the bookmarks page and retry",
  capture_failed: "capture failed inside the platform tab",
};

async function handlePopupCommand(msg: PopupCommandMessage): Promise<BackgroundResult> {
  switch (msg.action) {
    case "queue-status":
      return { ok: true, snapshot: await durableSnapshot() };
    case "reschedule":
      await rescheduleAlarm();
      return { ok: true };
    case "retry-queue":
      await wakeDurableQueue(true, msg.source);
      return { ok: true, snapshot: await durableSnapshot() };
    case "save-page": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: "no active tab" };
      return await capturePage(tab.id, "toolbar");
    }
    case "start": {
      const creds = await settings();
      if (!creds) {
        await patchStatus(msg.source, {
          message: "enter the server and token, then press Save",
        });
        return { ok: false, error: "extension is not configured" };
      }
      await startCapture(msg.source);
      return { ok: true };
    }
    case "stop": {
      const tabId = await persistentState().runs.stop(msg.source);
      if (tabId !== null) await browser.tabs.remove(tabId).catch(() => {});
      await patchStatus(msg.source, { startedAt: null, message: "stopped" });
      return { ok: true };
    }
  }
}

async function handlePageEvent(
  msg: PageEventMessage,
  source: PlatformSource,
): Promise<BackgroundResult> {
  switch (msg.action) {
    case "ready":
      return { ok: true };
    case "page":
      await deliverRaw(source, msg.raw, msg.page, msg.cursor ?? null);
      await patchStatus(source, { pages: msg.page, items: msg.items });
      return { ok: true };
    case "saved":
      await persistentState().runs.requestRefresh(source);
      browser.alarms.create(OUTBOX_ALARM, { when: Date.now() + 2_500 });
      return { ok: true };
    case "bookmark":
      await handleBookmarkMutation(
        source,
        msg.bookmarkAction,
        msg.externalId,
        msg.canonicalUrl,
        msg.raw,
      );
      return { ok: true };
    case "observed": {
      await deliverRaw(source, msg.raw);
      const current = await readStatus(source);
      await patchStatus(source, {
        lastRun: Date.now(),
        items: current.items + msg.items,
      });
      return { ok: true };
    }
    case "done":
      // Before finishing: the pages this run queued are what give the held
      // saves their content, and the queue is serial per source.
      await flushPendingSaves(source);
      await finishRun(source);
      await patchStatus(source, {
        startedAt: null,
        lastRun: Date.now(),
        pages: msg.pages,
        items: msg.items,
        message: msg.items === 0 ? "run returned zero items" : null,
      });
      await processPendingRefreshes();
      return { ok: true };
    case "identified":
      await persistentState().runs.setHandle(source, msg.handle);
      return { ok: true };
    case "scanned": {
      const current = await readStatus(source);
      await finishRun(source);
      await patchStatus(source, {
        startedAt: null,
        lastRun: Date.now(),
        message: current.items > 0 ? null : "nothing loaded on that page",
      });
      await processPendingRefreshes();
      return { ok: true };
    }
    case "error":
      await persistentState().runs.noteError(source, msg.errorCode);
      await finishRun(source);
      await patchStatus(source, {
        startedAt: null,
        message: SAFE_PLATFORM_ERRORS[msg.errorCode],
      });
      await processPendingRefreshes();
      return { ok: true };
  }
}

async function handleRuntimeMessage(
  message: unknown,
  sender: RuntimeMessageSender,
): Promise<BackgroundResult> {
  const parsed = validateRuntimeMessage(message, sender);
  if (!parsed.ok) return { ok: false, error: parsed.error.message };

  try {
    if (parsed.message.anansi === "popup-command") {
      return await handlePopupCommand(parsed.message);
    }
    if (parsed.message.anansi === "page-event" && parsed.source) {
      return await handlePageEvent(parsed.message, parsed.source);
    }
    return { ok: false, error: "message family is not allowed on this path" };
  } catch {
    const source = parsed.source ?? "_";
    await patchStatus(source, { startedAt: null, message: "background action failed" });
    return { ok: false, error: "background action failed" };
  }
}

export default defineBackground(() => {
  /**
   * The menus are created on install rather than on every start.
   *
   * A service worker starts many times a day and createContextMenus throws on
   * a duplicate id, so recreating them per start means an exception in the log
   * every time — and a swallowed one is how a real error later gets missed.
   */
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      for (const menu of MENUS) {
        browser.contextMenus.create(menu);
      }
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === "anansi-save-page") {
      void capturePage(tab.id, "context_menu");
    }
    if (info.menuItemId === "anansi-save-selection") {
      void capturePage(tab.id, "context_menu", info.selectionText);
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, sender: RuntimeMessageSender) =>
    handleRuntimeMessage(message, sender),
  );

  /**
   * Automatic sync. Incremental by nature rather than by flag: every capture
   * path stops at the first page it has already seen, and the ingest upsert is
   * idempotent on (source, external_id), so a repeated run costs a request and
   * changes nothing.
   */
  browser.alarms.onAlarm.addListener((alarm) => {
    void (async () => {
      if (alarm.name === OUTBOX_ALARM) {
        await wakeDurableQueue();
        await processPendingRefreshes();
        return;
      }
      if (alarm.name !== ALARM) return;
      const config = await loadConfig();
      for (const entry of config?.sources ?? []) {
        if (entry.mode !== "page") continue;
        await startCapture(entry.source, true);
      }
    })();
  });

  void rescheduleAlarm();
  void wakeDurableQueue().then(processPendingRefreshes);
  browser.runtime.onStartup.addListener(() => {
    void wakeDurableQueue().then(processPendingRefreshes);
  });
  browser.runtime.onInstalled.addListener(() => {
    void wakeDurableQueue().then(processPendingRefreshes);
  });

  // Arm the observers on every matching tab as it loads, so real-time capture
  // works without anyone opening the popup.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" || !tab.url) return;
    void loadConfig().then((config) => {
      const entry = config?.sources.find((candidate) =>
        tab.url?.includes(candidate.host.replace("www.", "")),
      );
      if (entry) {
        void browser.tabs.sendMessage(
          tabId,
          {
            anansi: "page-command",
            messageVersion: MESSAGE_PROTOCOL_VERSION,
            source: entry.source,
            action: "configure",
            config: entry,
          },
        ).catch(() => {});
      }
    });
  });
});
