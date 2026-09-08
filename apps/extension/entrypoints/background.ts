/**
 * The background worker: the only part of the extension that knows a server
 * exists, and the only part that holds the token.
 *
 * Coordinates session imports, page observers, and durable delivery. GitHub
 * HTML is reduced to repository records locally; JSON source payloads are
 * normalized by the server. Session credentials stay in the browser.
 */

import type {
  CaptureQueueStatus,
  HeartbeatSourceState,
  ItemEventCapture,
  RawPageCapture,
  ExtensionRemoteConfig,
  ExtensionSourceConfig,
  ShippedCaptureSource,
} from "@anansi/sources";
import {
  EXTENSION_PLATFORM_SOURCES,
  SHIPPED_CAPTURE_SOURCES,
  isExtensionPlatformSource,
  parseExtensionConfig,
} from "@anansi/sources";
import { type CaptureQueue, createCaptureQueue } from "../lib/capture-queue.ts";
import { type BookmarkNode, importCaptures, removalCaptures, toBookmarkCapture } from "../lib/chrome-bookmarks.ts";
import { cachedForServer, type ServerCache } from "../lib/config-cache.ts";
import { extensionConnection } from "../lib/connection.ts";
import { createHeartbeatClient, type HeartbeatClient } from "../lib/heartbeat.ts";
import { createIndexedDbOutbox, type IndexedDbOutbox } from "../lib/idb-outbox.ts";
import { createIngestTransport, safeHttpErrorDetail } from "../lib/ingest-transport.ts";
import {
  MESSAGE_PROTOCOL_VERSION,
  type PageEventMessage,
  type PlatformSource,
  type PopupCommandMessage,
  parseExtensionMessage,
} from "../lib/messages.ts";
import { capturablePage, type PageDetails, readPage, toWebCapture, UNSUPPORTED_MESSAGES } from "../lib/page-capture.ts";
import { tweetUrl } from "../lib/platforms/x.ts";
import {
  SYNC_ALARM,
  scheduleDailyCatchUp,
  scheduleOutboxRetry,
} from "../lib/schedule.ts";
import { runSessionImport, SessionImportError, type SessionSource } from "../lib/session-import.ts";
import {
  createSourceImportLifecycle,
  SourceImportLifecycleError,
  type SourceImportEffect,
  type SourceImportLifecycle,
  type SourceImportPage,
} from "../lib/source-import-lifecycle.ts";
import {
  type CaptureSource,
  captureDeliveryMode,
  createSourceRuns,
  isExpectedImportTab,
  type SourceRuns,
} from "../lib/source-runs.ts";

export interface Settings {
  server: string;
  token: string;
}

export type SourceConfig = ExtensionSourceConfig;
export type RemoteConfig = ExtensionRemoteConfig;

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
const ALARM = SYNC_ALARM;
const OUTBOX_ALARM = "anansi-outbox";
const HEARTBEAT_ALARM = "anansi-heartbeat";
const SOURCE_RUN_RECOVERY_ALARM_PREFIX = "anansi-source-run-recovery:";
const CAPTURE_SOURCES = EXTENSION_PLATFORM_SOURCES;
const HEARTBEAT_SOURCES = SHIPPED_CAPTURE_SOURCES;
const tabNonces = new Map<number, string>();

let cached: ServerCache<RemoteConfig> | null = null;
let cachedToken: string | null = null;
let persistent: { outbox: IndexedDbOutbox; runs: SourceRuns } | null = null;
let durableQueue: CaptureQueue | null = null;
let healthHeartbeat: HeartbeatClient | null = null;
const sessionImports = new Map<SessionSource, { controller: AbortController; task: Promise<void>; runId: string }>();
let importLifecycle: SourceImportLifecycle | null = null;

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
  const { origin, token } = extensionConnection();
  return { server: origin, token };
}

async function patchStatus(source: string, patch: Partial<SourceStatus>): Promise<void> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  const current = all[source] ?? {
    startedAt: null,
    lastRun: null,
    pages: 0,
    items: 0,
    uploaded: 0,
    failed: 0,
    message: null,
  };
  await browser.storage.local.set({
    status: { ...all, [source]: { ...current, ...patch } },
  });
  requestHeartbeat();
}

async function readStatus(source: string): Promise<SourceStatus> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  return (
    all[source] ?? {
      startedAt: null,
      lastRun: null,
      pages: 0,
      items: 0,
      uploaded: 0,
      failed: 0,
      message: null,
    }
  );
}

/** Status writes from an import must not outlive the run that produced them. */
async function patchStatusForRun(
  source: CaptureSource,
  runId: string,
  patch: Partial<SourceStatus>,
): Promise<boolean> {
  return persistentState().runs.runIfCurrent(source, runId, async () => {
    await patchStatus(source, patch);
  });
}

/**
 * Revalidated hourly rather than fetched per run, and the kill switch: a
 * source switched off in the web app simply stops appearing here, so capture
 * for it stops on the next run without anyone updating anything.
 */
async function loadConfig(force = false): Promise<RemoteConfig | null> {
  const s = await settings();
  if (!s) return null;
  if (cachedToken !== s.token) {
    cached = null;
    cachedToken = s.token;
  }
  const now = Date.now();
  const fresh = cachedForServer(cached, s.server, now, CONFIG_TTL_MS);
  if (!force && fresh) return fresh;

  const url = `${s.server}/api/extension/config`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${s.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) cached = null;
    if (res.status === 404) {
      throw new Error(`404 at ${url} — is an older Anansi server still on that port?`);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    const parsed = parseExtensionConfig(await res.json());
    if (!parsed.ok) {
      throw new Error(`invalid extension config: ${parsed.error.message}`);
    }
    cached = { serverOrigin: s.server, at: Date.now(), value: parsed.config };
    await patchStatus("_", { message: null });
    return parsed.config;
  } catch (err) {
    await patchStatus("_", { message: (err as Error).message });
    return cachedForServer(cached, s.server, Date.now(), CONFIG_TTL_MS, true);
  }
}

function isCaptureSource(source: string): source is CaptureSource {
  return isExtensionPlatformSource(source);
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
        browser.alarms.create(OUTBOX_ALARM, {
          when: Math.max(Date.now() + 100, at),
        });
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

function heartbeat(): HeartbeatClient {
  if (healthHeartbeat) return healthHeartbeat;
  healthHeartbeat = createHeartbeatClient({
    storage: {
      async get(key) {
        return (await browser.storage.local.get(key))[key];
      },
      set: (values) => browser.storage.local.set(values),
    },
    version: browser.runtime.getManifest().version,
    createId: () => crypto.randomUUID(),
    now: () => Math.floor(Date.now() / 1000),
    async readState() {
      const snapshot = await durableSnapshot();
      const sources: Partial<Record<ShippedCaptureSource, HeartbeatSourceState>> = {};
      for (const source of HEARTBEAT_SOURCES) {
        const run = snapshot.runs[source];
        const counts = snapshot.bySource[source] ?? EMPTY_COUNTS;
        sources[source] = {
          phase: run?.phase ?? "idle",
          ...(run?.paused ? { paused: true } : {}),
          ...(run?.lastErrorCode ? { lastErrorCode: run.lastErrorCode } : {}),
          ...counts,
        };
      }
      return { queue: snapshot.queue, sources };
    },
    async transport(payload) {
      const current = await settings();
      if (!current) throw new Error("extension is not configured");
      const response = await fetch(`${current.server}/api/extension/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${current.token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("heartbeat rejected");
    },
  });
  return healthHeartbeat;
}

function requestHeartbeat(): void {
  void heartbeat().send();
}

async function wakeDurableQueue(includeFailed = false, source?: CaptureSource): Promise<CaptureQueueStatus> {
  const status = await queue().retry(
    includeFailed ? { includeFailed: true, ...(source ? { source } : {}) } : undefined,
  );
  requestHeartbeat();
  return status;
}

/** Legacy direct upload, kept only while a source's captureV2 flag is off. */
async function legacyUpload(source: string, raw: unknown): Promise<boolean> {
  const [s, config] = await Promise.all([settings(), loadConfig()]);
  if (!s || !config) return false;

  try {
    const res = await fetch(config.ingest, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify({ source, raw }),
    });
    const current = await readStatus(source);
    if (res.ok) {
      await patchStatus(source, {
        uploaded: current.uploaded + 1,
        message: null,
      });
      return true;
    } else {
      // 422 is the server's zero-parse alarm. It means the payload shape
      // changed, and it must be visible rather than swallowed.
      const detail = await safeHttpErrorDetail(res);
      await patchStatus(source, {
        failed: current.failed + 1,
        message: `ingest ${res.status}${detail ? `: ${detail}` : ""}`,
      });
      return false;
    }
  } catch (err) {
    const current = await readStatus(source);
    await patchStatus(source, {
      failed: current.failed + 1,
      message: (err as Error).message,
    });
    return false;
  }
}

/** Exactly one delivery path owns a payload, selected by its source flag. */
async function deliverRaw(
  source: CaptureSource,
  raw: unknown,
  requestedPage?: number,
  cursor?: string | null,
  captureMethod: "platform_import" | "platform_event" = "platform_import",
): Promise<void> {
  const config = await loadConfig();
  const delivery = captureDeliveryMode(config?.ingestProtocolVersion, config?.features?.captureV2, source);
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
    captureMethod,
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

  const [pending, current] = await Promise.all([outbox.get(enqueued.eventId), readStatus(source)]);
  if (!pending) {
    await patchStatus(source, {
      uploaded: current.uploaded + 1,
      message: null,
    });
  } else if (pending.state === "failed") {
    await patchStatus(source, {
      failed: current.failed + 1,
      message: pending.lastError?.message ?? "capture delivery failed",
    });
  } else {
    await patchStatus(source, {
      message: "saved locally; delivery will retry",
    });
  }
}

/** Queue adapter used by the lifecycle; resolving is the durable page receipt. */
async function enqueueImportedPage(page: SourceImportPage): Promise<void> {
  const config = await loadConfig();
  const delivery = captureDeliveryMode(
    config?.ingestProtocolVersion,
    config?.features?.captureV2,
    page.source,
  );
  if (delivery === "legacy") {
    if (!(await legacyUpload(page.source, page.raw))) {
      throw new Error("legacy ingest rejected the capture");
    }
    return;
  }
  const capture: RawPageCapture = {
    schemaVersion: 1,
    payloadType: "raw_page",
    eventId: page.eventId,
    source: page.source,
    action: "snapshot",
    observedAt: Math.floor(Date.now() / 1000),
    captureMethod: page.captureMethod,
    runId: page.runId,
    page: page.page,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    raw: page.raw,
  };
  await queue().enqueue(capture);
  await wakeDurableQueue().catch(() => {});
}

function sourceImportLifecycle(): SourceImportLifecycle {
  if (importLifecycle) return importLifecycle;
  const { runs } = persistentState();
  importLifecycle = createSourceImportLifecycle({
    runs,
    enqueuePage: enqueueImportedPage,
    flushPendingSaves,
    isEnabled: async (source) => {
      const config = await loadConfig(true);
      return Boolean(config?.enabled && config.sources.some((entry) => entry.source === source));
    },
  });
  return importLifecycle;
}

async function applyImportEffects(effects: SourceImportEffect[]): Promise<void> {
  const runs = persistentState().runs;
  for (const effect of effects) {
    if (effect.kind === "schedule-recovery") {
      await runs.runIfCurrent(effect.source, effect.runId, async (run) => {
        if (run.phase !== "running") return;
        browser.alarms.create(sourceRunRecoveryAlarm(effect.source), {
          when: effect.at,
        });
      });
    } else if (effect.kind === "clear-recovery") {
      await runs.runIfCurrent(effect.source, effect.runId, async () => {
        await clearSourceRunRecovery(effect.source);
      });
    } else if (effect.kind === "close-owned-tab") {
      // takeOwnedTabForRun is itself fenced and consumes the ownership before
      // the browser call. A stale close can therefore only release the tab
      // recorded for its own run (or its persisted orphan), never a replacement.
      await closeOwnedTab(effect.source, effect.runId, effect.expectedTabId);
    } else if (effect.kind === "process-pending-refresh") {
      // claimRefresh rechecks each source under the shared serialized tail;
      // there is no separate check whose result could go stale here.
      await processPendingRefreshes();
    } else {
      await runs.runIfCurrent(effect.source, effect.runId, async () => {
        await patchStatus(effect.source, effect.patch as Partial<SourceStatus>);
      });
    }
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
): Promise<boolean> {
  const mode = async (force: boolean) => {
    const config = await loadConfig(force);
    return captureDeliveryMode(config?.ingestProtocolVersion, config?.features?.captureV2, source);
  };

  /**
   * Ask again before giving up.
   *
   * The config is cached for an hour, and this is the one path where acting on
   * an hour-old copy is silently wrong: enabling a source on the server did
   * nothing until the cache expired, so an unsave made in that window
   * disappeared with no record anywhere. A mutation happens at human pace, and
   * the server is on this machine, so one revalidation costs nothing.
   */
  let delivery = await mode(false);
  if (delivery === "legacy") delivery = await mode(true);

  /**
   * Legacy delivery has no way to say "this one item changed", so there is
   * nothing to send — but saying nothing is what made this look like it
   * worked. An unsave that cannot be delivered has to leave a mark.
   */
  if (delivery === "legacy") {
    await patchStatus(source, {
      message:
        action === "unsave"
          ? "unsave not recorded — this source is not enabled for precise capture on the server"
          : "save state not recorded — this source is not enabled for precise capture on the server",
    });
    return false;
  }

  const observedAt = Math.floor(Date.now() / 1000);
  const identity =
    source === "github" ? `sequence:${await persistentState().runs.nextItemEventSequence(source)}` : String(observedAt);
  const capture: ItemEventCapture = {
    schemaVersion: 1,
    payloadType: "item_event",
    eventId: `${source}:${action}:${externalId}:${identity}`,
    source,
    action,
    observedAt,
    captureMethod: "platform_event",
    externalId,
    canonicalUrl: canonicalUrl ?? (source === "github" ? `https://github.com/${externalId}` : tweetUrl(externalId)),
  };
  await queue().enqueue(capture);
  await wakeDurableQueue().catch(() => {});
  return true;
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
  scheduleOutboxRetry(browser.alarms, OUTBOX_ALARM, Date.now());
}

/** Send the held saves now that the pages carrying their content are queued. */
const pendingSaveFlushes = new Set<CaptureSource>();

async function flushPendingSaves(source: CaptureSource): Promise<void> {
  if (pendingSaveFlushes.has(source)) return;
  pendingSaveFlushes.add(source);
  try {
    const runs = persistentState().runs;
    const pending = await runs.takePendingSaves(source);
    for (const externalId of pending) {
      try {
        if (await deliverItemEvent(source, "save", externalId)) {
          await runs.ackPendingSave(source, externalId);
        }
      } catch (error) {
        // The id stays durable until its event is queued. Ask for another
        // small refresh so a transient queue/config failure gets retried.
        scheduleOutboxRetry(browser.alarms, OUTBOX_ALARM, Date.now());
        await runs.requestRefresh(source).catch(() => {});
        await patchStatus(source, {
          message:
            error instanceof Error
              ? `save state pending: ${error.message}`
              : "save state pending; delivery will retry",
        });
      }
    }
  } finally {
    pendingSaveFlushes.delete(source);
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
): Promise<{ ok: true; delivery: "queued" | "uploaded" } | { ok: false; error: string }> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const supported = capturablePage(tab?.url);
  if (!supported.ok) {
    await patchStatus("web", {
      message: UNSUPPORTED_MESSAGES[supported.reason],
    });
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
  return { ok: true, delivery: pending ? "queued" : "uploaded" };
}

type MenuSpec = Parameters<typeof browser.contextMenus.create>[0];

/* ------------------------------------------------- chrome bookmarks --- */

const MIRROR_KEY = "mirrorChromeBookmarks";
let bookmarkInstallation: Promise<string> | undefined;
function bookmarkInstallationId(): Promise<string> {
  return (bookmarkInstallation ??= (async () => {
    const stored = await browser.storage.local.get("bookmarkInstallationId");
    if (typeof stored.bookmarkInstallationId === "string") return stored.bookmarkInstallationId;
    const id = crypto.randomUUID();
    await browser.storage.local.set({ bookmarkInstallationId: id });
    return id;
  })().catch((error) => {
    bookmarkInstallation = undefined;
    throw error;
  }));
}

async function mirroringOn(): Promise<boolean> {
  const stored = await browser.storage.local.get(MIRROR_KEY);
  if (stored[MIRROR_KEY] !== true) return false;
  // The setting is not the authority; the grant is. A permission revoked from
  // Chrome's own settings would otherwise leave this claiming to mirror.
  return browser.permissions.contains({ permissions: ["bookmarks"] }).catch(() => false);
}

async function enqueueBookmarks(captures: Awaited<ReturnType<typeof importCaptures>>) {
  if (captures.length === 0) return;
  let accepted = 0;
  for (const capture of captures) {
    try {
      await queue().enqueue(capture);
      accepted++;
    } catch {
      /* Report partial persistence below; never count it as saved. */
    }
  }
  await wakeDurableQueue();
  const current = await readStatus("web");
  await patchStatus("web", {
    lastRun: Date.now(),
    items: current.items + accepted,
    message:
      accepted < captures.length
        ? `${captures.length - accepted} bookmarks could not be saved on this device; turn mirroring off and on to retry`
        : null,
  });
}

/**
 * Listeners exist only while the permission does.
 *
 * Registering them regardless and checking inside would mean the extension
 * asks Chrome for bookmark events it has no right to, and gets them the
 * moment someone grants the permission for something else.
 */
let bookmarkListeners: null | {
  created: Parameters<typeof browser.bookmarks.onCreated.addListener>[0];
  changed: Parameters<typeof browser.bookmarks.onChanged.addListener>[0];
  removed: Parameters<typeof browser.bookmarks.onRemoved.addListener>[0];
} = null;

async function startMirroring(): Promise<void> {
  if (bookmarkListeners || !(await mirroringOn())) return;

  const now = () => Math.floor(Date.now() / 1000);
  const options = { installationId: await bookmarkInstallationId() };

  const created = async (_id: string, node: BookmarkNode) => {
    const capture = await toBookmarkCapture(node, "save", now(), options);
    if (capture) await enqueueBookmarks([capture]);
  };

  const changed = async (id: string, info: { title?: string; url?: string }) => {
    // onChanged carries only what changed, so the node is read back for the
    // url — a rename with no url would otherwise identify nothing.
    const [node] = await browser.bookmarks.get(id).catch(() => []);
    if (!node) return;
    const capture = await toBookmarkCapture(
      { ...(node as BookmarkNode), title: info.title ?? node.title },
      "save",
      now(),
      options,
    );
    if (capture) await enqueueBookmarks([capture]);
  };

  const removed = async (_id: string, info: { node: BookmarkNode }) => {
    await enqueueBookmarks(await removalCaptures(info.node, now(), options));
  };

  bookmarkListeners = {
    created: created as never,
    changed: changed as never,
    removed: removed as never,
  };
  browser.bookmarks.onCreated.addListener(bookmarkListeners.created);
  browser.bookmarks.onChanged.addListener(bookmarkListeners.changed);
  browser.bookmarks.onRemoved.addListener(bookmarkListeners.removed);
}

function stopMirroring(): void {
  if (!bookmarkListeners) return;
  browser.bookmarks.onCreated.removeListener(bookmarkListeners.created);
  browser.bookmarks.onChanged.removeListener(bookmarkListeners.changed);
  browser.bookmarks.onRemoved.removeListener(bookmarkListeners.removed);
  bookmarkListeners = null;
}

/**
 * Turning mirroring on, which is when the permission is asked for.
 *
 * Denial is not an error state: nothing else in the extension depends on
 * this, so it simply stays off and says so.
 */
async function setMirroring(on: boolean): Promise<BackgroundResult> {
  if (!on) {
    stopMirroring();
    await browser.storage.local.set({ [MIRROR_KEY]: false });
    // Handed back rather than kept for later. Items already mirrored stay:
    // the library keeps what you saved.
    await browser.permissions.remove({ permissions: ["bookmarks"] }).catch(() => false);
    await patchStatus("web", { message: null });
    return { ok: true, mirroring: false };
  }

  const granted = await browser.permissions.request({ permissions: ["bookmarks"] }).catch(() => false);
  if (!granted) {
    await browser.storage.local.set({ [MIRROR_KEY]: false });
    return {
      ok: false,
      error: "Chrome did not grant access to your bookmarks",
    };
  }

  await browser.storage.local.set({ [MIRROR_KEY]: true });
  await startMirroring();

  const tree = (await browser.bookmarks.getTree().catch(() => [])) as BookmarkNode[];
  await enqueueBookmarks(
    await importCaptures(tree, Math.floor(Date.now() / 1000), {
      installationId: await bookmarkInstallationId(),
    }),
  );
  return { ok: true, mirroring: true };
}

const MENUS: MenuSpec[] = [
  { id: "anansi-save-page", title: "Save page to Anansi", contexts: ["page"] },
  {
    id: "anansi-save-selection",
    title: "Save selection to Anansi",
    contexts: ["selection"],
  },
];

/** Where to open a tab when there isn't one, per source. */
const ENTRY_URLS: Record<string, string> = {
  x: "https://x.com/i/bookmarks",
  reddit: "https://www.reddit.com/user/me/saved/",
  github: "https://github.com/stars",
};

const HOST_PATTERNS: Record<string, string[]> = {
  x: ["https://x.com/*", "https://twitter.com/*"],
  reddit: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  github: ["https://github.com/*"],
};

async function findTab(source: CaptureSource, expectedUrl?: string) {
  const patterns = HOST_PATTERNS[source];
  if (!patterns) return undefined;
  const tabs = await browser.tabs.query({ url: patterns });
  return tabs.find(
    (tab) =>
      tab.url && isExpectedImportTab(source, tab.url) && (!expectedUrl || tab.url === expectedUrl),
  );
}

/**
 * Open a tab for a source and wait for its content scripts.
 *
 * Opened inactive, so an import does not yank you out of what you were doing,
 * and closed again afterwards if we were the ones who opened it.
 */
async function openTab(source: CaptureSource, preferredUrl?: string): Promise<{ id: number; ours: boolean } | null> {
  const url = preferredUrl ?? ENTRY_URLS[source];
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

async function closeOwnedTab(
  source: CaptureSource,
  runId: string,
  expectedTabId?: number,
): Promise<void> {
  await persistentState().runs.closeOwnedTabForRun(
    source,
    runId,
    expectedTabId,
    async (tabId) => {
      await browser.tabs.remove(tabId).catch(() => {});
    },
  );
}

function sourceRunRecoveryAlarm(source: CaptureSource): string {
  return `${SOURCE_RUN_RECOVERY_ALARM_PREFIX}${source}`;
}

function clearSourceRunRecovery(source: CaptureSource): Promise<boolean> {
  return browser.alarms.clear(sourceRunRecoveryAlarm(source));
}

async function expireOwnedRun(
  source: CaptureSource,
  expectedTabId: number,
  runId: string,
): Promise<void> {
  const failed = await sourceImportLifecycle().fail({
    source,
    runId,
    tabId: expectedTabId,
    code: "capture_timeout",
  });
  if (failed.kind === "ignored-stale") return;
  await applyImportEffects(failed.effects);
  await patchStatusForRun(source, runId, {
    startedAt: null,
    message: "capture timed out; retry when the platform is ready",
  });
}

/**
 * GitHub and Reddit use credentialed worker requests. X still uses a page
 * script and opens an inactive tab when it needs one.
 */
async function startCapture(source: string, quiet = false, live = false): Promise<void> {
  if (!isCaptureSource(source)) return;
  if ((source === "github" || source === "reddit") && sessionImports.has(source)) return;
  const begun = await sourceImportLifecycle().start(source, live ? "live" : "full");
  await applyImportEffects(
    quiet && (begun.kind === "already-running" || begun.kind === "disabled")
      ? begun.effects.filter((effect) => effect.kind !== "status")
      : begun.effects,
  );
  if (begun.kind !== "started") {
    if (begun.kind === "disabled") return;
    if (quiet) return;
    return;
  }
  const runId = begun.run.runId;

  const config = await loadConfig(true);
  if (!config?.enabled) {
    if (!quiet) await patchStatusForRun(source, runId, { message: "server has capture disabled" });
    await applyImportEffects((await sourceImportLifecycle().stop(source, runId)).effects);
    return;
  }

  const entry = config.sources.find((s) => s.source === source);
  if (!entry) {
    if (!quiet) await patchStatusForRun(source, runId, { message: "switched off in Sources" });
    await applyImportEffects((await sourceImportLifecycle().stop(source, runId)).effects);
    return;
  }

  if (source === "github" || source === "reddit") {
    const controller = new AbortController();
    const task = importWithoutTab(source, runId, entry, live, controller.signal);
    sessionImports.set(source, { controller, task, runId });
    try {
      await task;
    } finally {
      sessionImports.delete(source);
    }
    if (!controller.signal.aborted) await processPendingRefreshes();
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
    await applyImportEffects((await sourceImportLifecycle().fail({
      source,
      runId,
      code: "platform_request_failed",
    })).effects);
    await patchStatusForRun(source, runId, {
      startedAt: null,
      message: `could not open ${entry.host}`,
    });
    return;
  }
  const tab = { id: target.id };
  // Record ownership immediately after creating our tab. If the run expires
  // while bind/configure is waiting on the page, a replacement can orphan and
  // close this exact tab instead of leaving it behind.
  if (
    target.ours &&
    !(await persistentState().runs.setOwnedTabForRun(source, runId, tab.id))
  ) {
    await persistentState().runs.disposeUnclaimedTab(
      source,
      runId,
      tab.id,
      async () => {
        await browser.tabs.remove(tab.id).catch(() => {});
      },
    );
    return;
  }
  const bound = await sourceImportLifecycle().bindTab(
    source,
    runId,
    tab.id,
    false,
  );
  await applyImportEffects(bound.effects);
  if (bound.kind === "ignored-stale") return;

  if (entry.mode === "observe") {
    const configure = () =>
      talk(tab.id, {
        anansi: "page-command",
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source,
        runId,
        action: "configure",
        config: entry,
      });

    if (!(await configure())) {
      await applyImportEffects((await sourceImportLifecycle().fail({
        source,
        runId,
        tabId: tab.id,
        code: "platform_request_failed",
      })).effects);
      await patchStatusForRun(source, runId, {
        startedAt: null,
        message: `could not reach the ${entry.host} tab`,
      });
      return;
    }

    // Nothing to request, so the capture is a scroll: the app fetches its own
    // item lists as the page grows, and those are what get kept.
    await patchStatusForRun(source, runId, {
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
      await applyImportEffects((await sourceImportLifecycle().fail({
        source,
        runId,
        tabId: tab.id,
        code: "platform_request_failed",
      })).effects);
      await patchStatusForRun(source, runId, {
        startedAt: null,
        message: `could not start the ${entry.host} scan`,
      });
      return;
    }
    if (target.ours) {
      setTimeout(() => void expireOwnedRun(source, tab.id, runId), 90_000);
    }
    return;
  }

  /**
   * A live sync is one small page, not a whole run. The thing you just saved
   * is at the top of the listing, so twenty items reaches it with room to
   * spare — and the upsert makes the nineteen you already have free.
   */
  const job = live
    ? {
        ...entry,
        pageLimit: 1,
        variables: { ...(entry.variables ?? {}), count: 20 },
      }
    : // A full run picks up where the last acknowledged page left off, so an
      // import interrupted at page nine does not start again at page one.
      {
        ...entry,
        ...(begun.run.cursor ? { resumeCursor: begun.run.cursor } : {}),
      };
    await patchStatusForRun(source, runId, {
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
      runId,
      action: "configure",
      config: job,
    })) &&
    (await talk(tab.id, {
      anansi: "page-command",
      messageVersion: MESSAGE_PROTOCOL_VERSION,
      source,
      runId,
      action: "backfill",
      config: job,
    }));

  if (!reached) {
    await applyImportEffects((await sourceImportLifecycle().fail({
      source,
      runId,
      tabId: tab.id,
      code: "platform_request_failed",
    })).effects);
    await patchStatusForRun(source, runId, {
      startedAt: null,
      message: `could not reach the ${entry.host} tab; reload it and try again`,
    });
    return;
  }

  // Close a tab we opened once the run reports in, or after a ceiling.
  if (target.ours) {
    setTimeout(() => void expireOwnedRun(source, tab.id, runId), 180_000);
  }
}

async function importWithoutTab(
  source: SessionSource,
  runId: string,
  entry: SourceConfig,
  live: boolean,
  signal: AbortSignal,
): Promise<void> {
  const runs = persistentState().runs;
  const ownsRun = async () => {
    const run = await runs.current(source);
    return !signal.aborted && run.phase === "running" && run.runId === runId;
  };
  try {
    const run = await runs.current(source);
    await patchStatusForRun(source, runId, {
      startedAt: run.startedAt,
      pages: 0,
      items: 0,
      uploaded: 0,
      failed: 0,
      message: "importing in the background…",
    });
    const result = await runSessionImport({
      source,
      cursor: run.cursor,
      pageLimit: entry.pageLimit ?? 40,
      live,
      signal,
      isCurrent: async () => {
        if (!(await ownsRun())) return false;
        const config = await loadConfig(true);
        if (!(await ownsRun())) return false;
        if (!config?.enabled || !config.sources.some((candidate) => candidate.source === source)) {
          const disabled = await sourceImportLifecycle().stop(source, runId);
          await applyImportEffects(disabled.effects);
          return false;
        }
        return true;
      },
      onPage: async (page, number) => {
        const accepted = await sourceImportLifecycle().page({
          source,
          runId,
          page: number,
          items: page.items,
          cursor: live ? undefined : page.cursor,
          raw: page.raw,
          captureMethod: live ? "platform_event" : "platform_import",
        });
        await applyImportEffects(accepted.effects);
        if (accepted.kind === "queue-failed") {
          const code =
            accepted.errorCode === "queue_full" ||
            accepted.errorCode === "record_too_large"
              ? accepted.errorCode
              : "queue_failed";
          throw new SourceImportLifecycleError(
            code,
            "capture queue rejected the page",
          );
        }
        if (accepted.kind === "ignored-stale" || accepted.kind === "disabled") {
          throw new SourceImportLifecycleError("stale_run", "source run is no longer current");
        }
        if (accepted.kind !== "accepted-page") {
          throw new Error("source import page was not accepted");
        }
        const current = await readStatus(source);
        await patchStatusForRun(source, runId, {
          pages: number,
          items: current.items + page.items,
        });
      },
    });
    const completed = await sourceImportLifecycle().complete({
      source,
      runId,
      state: result.state,
      pages: result.pages,
      items: result.items,
      initialImport: !live,
    });
    await applyImportEffects(completed.effects);
  } catch (error) {
    if (
      error instanceof SourceImportLifecycleError &&
      (error.code === "queue_full" ||
        error.code === "record_too_large" ||
        error.code === "queue_failed")
    )
      return;
    if (error instanceof SourceImportLifecycleError && error.code === "stale_run") return;
    if (!(await ownsRun())) return;
    const code = error instanceof SessionImportError ? error.code : "platform_request_failed";
    const failed = await sourceImportLifecycle().fail({
      source,
      runId,
      code,
      retryAfterMs: error instanceof SessionImportError ? error.retryAfterMs : undefined,
    });
    await applyImportEffects(failed.effects);
    if (failed.kind === "failed") {
      await patchStatusForRun(source, runId, { message: SAFE_PLATFORM_ERRORS[code] });
    }
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
/**
 * Arm the tabs that were already open.
 *
 * Reloading an extension does not re-inject content scripts into tabs that
 * were already open, and observers were only ever armed by tabs.onUpdated. So
 * after every reload the x.com tab you were actually using had no script in it
 * at all — you could unsave something and nothing anywhere would notice, with
 * no error, because there was no code there to fail.
 *
 * `talk` reloads a tab that has nobody home, which is disruptive; that is why
 * this runs on install and update only, and not on the service worker's many
 * ordinary wakes.
 */
async function armOpenTabs(): Promise<void> {
  const config = await loadConfig(true);
  if (!config) return;

  for (const entry of config.sources) {
    const host = entry.host.replace("www.", "");
    const tabs = await browser.tabs.query({ url: `*://*.${host}/*` }).catch(() => []);
    for (const tab of tabs) {
      if (!tab.id) continue;
      await talk(tab.id, {
        anansi: "page-command",
        messageVersion: MESSAGE_PROTOCOL_VERSION,
        source: entry.source,
        action: "configure",
        config: entry,
      }).catch(() => false);
    }
  }
}

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
  await scheduleDailyCatchUp(browser.alarms);
}

async function rescheduleHeartbeat(): Promise<void> {
  await browser.alarms.clear(HEARTBEAT_ALARM);
  browser.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 2,
    delayInMinutes: 1,
  });
}

async function processPendingRefreshes(): Promise<void> {
  const runs = persistentState().runs;
  for (const source of CAPTURE_SOURCES) {
    if (await runs.claimRefresh(source)) await startCapture(source, true, true);
  }
}

async function maybeStartInitialGitHubImport(): Promise<void> {
  const runs = persistentState().runs;
  if (!(await runs.initialImportDue("github"))) return;
  const config = await loadConfig();
  if (!config?.enabled || !config.sources.some((entry) => entry.source === "github")) {
    return;
  }
  await startCapture("github", true);
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
  | {
      ok: true;
      delivery?: "queued" | "uploaded";
      snapshot?: Awaited<ReturnType<typeof durableSnapshot>>;
      /** Whether Chrome bookmark mirroring is on and still permitted. */
      mirroring?: boolean;
    }
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
  not_signed_in: "sign in to the platform in this browser, then press Import",
  query_unavailable: "the bookmark query is unavailable; open the bookmarks page and retry",
  capture_failed: "capture failed inside the platform tab",
  page_shape_changed: "the platform returned an unexpected page; update the extension before retrying",
  rate_limited: "the platform temporarily limited the import; retry later",
};

async function handlePopupCommand(msg: PopupCommandMessage): Promise<BackgroundResult> {
  switch (msg.action) {
    case "queue-status":
      return { ok: true, snapshot: await durableSnapshot() };
    case "reschedule":
      await rescheduleAlarm();
      void maybeStartInitialGitHubImport();
      return { ok: true };
    case "retry-queue":
      await wakeDurableQueue(true, msg.source);
      return { ok: true, snapshot: await durableSnapshot() };
    case "mirror-status":
      return { ok: true, mirroring: await mirroringOn() };
    case "mirror-on":
      return await setMirroring(true);
    case "mirror-off":
      return await setMirroring(false);
    case "save-page": {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) return { ok: false, error: "no active tab" };
      return await capturePage(tab.id, "toolbar");
    }
    case "start": {
      await startCapture(msg.source);
      return { ok: true };
    }
    case "stop": {
      if (msg.source === "github" || msg.source === "reddit") {
        const importing = sessionImports.get(msg.source);
        importing?.controller.abort();
        await importing?.task;
      }
      const current = await persistentState().runs.current(msg.source);
      if (current.runId) {
        const stopped = await sourceImportLifecycle().stop(msg.source, current.runId);
        await applyImportEffects(stopped.effects);
      }
      return { ok: true };
    }
  }
}

async function handlePageEvent(
  msg: PageEventMessage,
  source: PlatformSource,
  tabId?: number,
): Promise<BackgroundResult> {
  // Import results for these sources are owned by the worker. Old content
  // scripts in already-open tabs must not advance or finish its run.
  if ((source === "github" || source === "reddit") && ["page", "done", "error", "scanned"].includes(msg.action)) {
    return {
      ok: false,
      error: "import results are owned by the background worker",
    };
  }
  switch (msg.action) {
    case "ready":
      return { ok: true };
    case "page":
      {
        const accepted =
          msg.runId
            ? await sourceImportLifecycle().page({
                source,
                runId: msg.runId,
                tabId,
                page: msg.page,
                items: msg.items,
                cursor: msg.cursor ?? null,
                raw: msg.raw,
                captureMethod: "platform_import",
              })
            : { kind: "ignored-stale" as const, source, effects: [] };
        await applyImportEffects(accepted.effects);
        if (accepted.kind === "queue-failed") {
          return { ok: false, error: accepted.errorCode ?? "capture queue rejected the page" };
        }
        if (accepted.kind === "ignored-stale" || accepted.kind === "disabled") return { ok: true };
      }
      await patchStatusForRun(source, msg.runId ?? "", {
        pages: msg.page,
        items: msg.items,
      });
      return { ok: true };
    case "saved":
      await persistentState().runs.requestRefresh(source);
      scheduleOutboxRetry(browser.alarms, OUTBOX_ALARM, Date.now());
      return { ok: true };
    case "bookmark":
      await handleBookmarkMutation(source, msg.bookmarkAction, msg.externalId, msg.canonicalUrl, msg.raw);
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
      {
        if (!msg.runId) return { ok: true };
        const completed = await sourceImportLifecycle().complete({
          source,
          runId: msg.runId,
          tabId,
          state: msg.state,
          pages: msg.pages,
          items: msg.items,
          initialImport: true,
        });
        await applyImportEffects(completed.effects);
        if (completed.kind === "completed" && msg.items === 0) {
          await patchStatusForRun(source, msg.runId, { message: "run returned zero items" });
        }
      }
      return { ok: true };
    case "identified":
      await persistentState().runs.setHandle(source, msg.handle);
      return { ok: true };
    case "scanned": {
      const run = await persistentState().runs.current(source);
      if (run.runId) {
        const currentStatus = await readStatus(source);
        const completed = await sourceImportLifecycle().complete({
          source,
          runId: run.runId,
          tabId,
          initialImport: false,
        });
        await applyImportEffects(completed.effects);
        if (completed.kind === "completed" && currentStatus.items === 0) {
          await patchStatusForRun(source, run.runId, { message: "nothing loaded on that page" });
        }
      }
      return { ok: true };
    }
    case "error":
      {
        if (msg.runId) {
          const failed = await sourceImportLifecycle().fail({
            source,
            runId: msg.runId,
            tabId,
            code: msg.errorCode,
          });
          await applyImportEffects(failed.effects);
          if (failed.kind === "failed") {
            await patchStatusForRun(source, msg.runId, {
              startedAt: null,
              message: SAFE_PLATFORM_ERRORS[msg.errorCode],
            });
          }
        }
      }
      await processPendingRefreshes();
      return { ok: true };
  }
}

async function handleRuntimeMessage(message: unknown, sender: RuntimeMessageSender): Promise<BackgroundResult> {
  const parsed = validateRuntimeMessage(message, sender);
  if (!parsed.ok) return { ok: false, error: parsed.error.message };

  try {
    if (parsed.message.anansi === "popup-command") {
      return await handlePopupCommand(parsed.message);
    }
    if (parsed.message.anansi === "page-event" && parsed.source) {
      return await handlePageEvent(parsed.message, parsed.source, sender.tab?.id);
    }
    return { ok: false, error: "message family is not allowed on this path" };
  } catch {
    const source = parsed.source ?? "_";
    await patchStatus(source, {
      startedAt: null,
      message: "background action failed",
    });
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
      if (alarm.name.startsWith(SOURCE_RUN_RECOVERY_ALARM_PREFIX)) {
        const source = alarm.name.slice(SOURCE_RUN_RECOVERY_ALARM_PREFIX.length);
        if (!isCaptureSource(source)) return;
        const interrupted = await persistentState().runs.current(source);
        if (interrupted.phase !== "running") return;
        await startCapture(source, true, interrupted.runMode === "live");
        return;
      }
      if (alarm.name === HEARTBEAT_ALARM) {
        requestHeartbeat();
        return;
      }
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
  void rescheduleHeartbeat();
  void wakeDurableQueue().then(processPendingRefreshes);
  void maybeStartInitialGitHubImport();
  requestHeartbeat();
  // The worker restarts constantly; the listeners have to come back with it.
  void startMirroring();
  browser.runtime.onStartup.addListener(() => {
    void wakeDurableQueue().then(processPendingRefreshes);
    void maybeStartInitialGitHubImport();
    requestHeartbeat();
  });
  browser.runtime.onInstalled.addListener(() => {
    void wakeDurableQueue().then(processPendingRefreshes);
    void armOpenTabs();
    void maybeStartInitialGitHubImport();
    requestHeartbeat();
  });

  // Arm the observers on every matching tab as it loads, so real-time capture
  // works without anyone opening the popup.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" || !tab.url) return;
    void loadConfig().then((config) => {
      const entry = config?.sources.find((candidate) => tab.url?.includes(candidate.host.replace("www.", "")));
      if (entry) {
        void browser.tabs
          .sendMessage(tabId, {
            anansi: "page-command",
            messageVersion: MESSAGE_PROTOCOL_VERSION,
            source: entry.source,
            action: "configure",
            config: entry,
          })
          .catch(() => {});
      }
    });
  });
});
