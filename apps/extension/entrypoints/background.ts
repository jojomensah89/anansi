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
  sources: SourceConfig[];
}

export interface SourceStatus {
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

let cached: { at: number; config: RemoteConfig } | null = null;
const savedTimers = new Map<string, number>();

async function settings(): Promise<Settings | null> {
  const stored = await browser.storage.local.get(["server", "token", "syncEvery"]);
  const server = String(stored.server ?? "").replace(/\/+$/, "");
  const token = String(stored.token ?? "");
  const syncEvery = Number(stored.syncEvery ?? 0);
  return server && token ? { server, token, syncEvery } : null;
}

async function patchStatus(source: string, patch: Partial<SourceStatus>): Promise<void> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  const current = all[source] ?? { lastRun: null, pages: 0, items: 0, uploaded: 0, failed: 0, message: null };
  await browser.storage.local.set({ status: { ...all, [source]: { ...current, ...patch } } });
}

async function readStatus(source: string): Promise<SourceStatus> {
  const all = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  return all[source] ?? { lastRun: null, pages: 0, items: 0, uploaded: 0, failed: 0, message: null };
}

/**
 * Revalidated hourly rather than fetched per run, and the kill switch: a
 * source switched off in the web app simply stops appearing here, so capture
 * for it stops on the next run without anyone updating anything.
 */
async function loadConfig(force = false): Promise<RemoteConfig | null> {
  if (!force && cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
  const s = await settings();
  if (!s) return null;

  const url = `${s.server}/api/extension/config`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      throw new Error(`404 at ${url} — is an older Anansi server still on that port?`);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    const config = (await res.json()) as RemoteConfig;
    if (!Array.isArray(config.sources)) throw new Error(`unexpected config shape from ${url}`);
    cached = { at: Date.now(), config };
    return config;
  } catch (err) {
    await patchStatus("_", { message: (err as Error).message });
    return cached?.config ?? null;
  }
}

/** Upload one untouched payload. The server does the understanding. */
async function upload(source: string, raw: unknown): Promise<void> {
  const s = await settings();
  const config = await loadConfig();
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
      await patchStatus(source, {
        failed: current.failed + 1,
        message: `ingest ${res.status}: ${body.slice(0, 120)}`,
      });
    }
  } catch (err) {
    const current = await readStatus(source);
    await patchStatus(source, { failed: current.failed + 1, message: (err as Error).message });
  }
}

const HOST_PATTERNS: Record<string, string[]> = {
  x: ["https://x.com/*", "https://twitter.com/*"],
  reddit: ["https://www.reddit.com/*", "https://old.reddit.com/*", "https://reddit.com/*"],
  tiktok: ["https://www.tiktok.com/*", "https://tiktok.com/*"],
};

async function findTab(source: string) {
  const patterns = HOST_PATTERNS[source];
  if (!patterns) return undefined;
  const tabs = await browser.tabs.query({ url: patterns });
  return tabs[0];
}

/**
 * Capture runs in a tab you already have open.
 *
 * Deliberately not from the background worker, which would mean reading your
 * cookies through the `cookies` permission and reconstructing a session the
 * page already has. That is a much broader grant for a convenience, and the
 * cost of not taking it is stated plainly: no open tab, no sync.
 */
async function startCapture(source: string, quiet = false, live = false): Promise<void> {
  const config = await loadConfig(true);
  if (!config?.enabled) {
    if (!quiet) await patchStatus(source, { message: "server has capture disabled" });
    return;
  }

  const entry = config.sources.find((s) => s.source === source);
  if (!entry) {
    if (!quiet) await patchStatus(source, { message: "switched off in Sources" });
    return;
  }

  const tab = await findTab(source);
  if (!tab?.id) {
    await patchStatus(source, { message: `open a logged-in ${entry.host} tab first` });
    return;
  }

  if (entry.mode === "observe") {
    await browser.tabs.sendMessage(tab.id, { anansi: "configure", config: entry }).catch(() => {});
    await patchStatus(source, {
      message: "watching — open your favourites and scroll to capture",
    });
    return;
  }

  /**
   * A live sync is one small page, not a whole run. The thing you just saved
   * is at the top of the listing, so twenty items reaches it with room to
   * spare — and the upsert makes the nineteen you already have free.
   */
  const job = live
    ? { ...entry, pageLimit: 1, variables: { ...(entry.variables ?? {}), count: 20 } }
    : entry;
  if (!quiet) {
    await patchStatus(source, { pages: 0, items: 0, uploaded: 0, failed: 0, message: "running…" });
  }
  await browser.tabs.sendMessage(tab.id, { anansi: "configure", config: job }).catch(() => {});
  await browser.tabs.sendMessage(tab.id, { anansi: "backfill", config: job }).catch(() => {});
}

async function rescheduleAlarm(): Promise<void> {
  await browser.alarms.clear(ALARM);
  const s = await settings();
  const minutes = s?.syncEvery ?? 0;
  if (minutes > 0) {
    browser.alarms.create(ALARM, { periodInMinutes: minutes, delayInMinutes: minutes });
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as Record<string, unknown> | undefined;
    if (!msg?.anansi) return undefined;

    // Everything below arrives from a content script sharing a context with
    // the site's own code. It is data, never instruction: the only thing done
    // with it is to forward it verbatim to the server.
    const source = String(msg.source ?? "x");

    void (async () => {
      switch (msg.anansi) {
        case "page":
          await upload(source, msg.raw);
          await patchStatus(source, {
            pages: Number(msg.page ?? 0),
            items: Number(msg.items ?? 0),
          });
          break;

        /**
         * Something was just saved in the UI.
         *
         * The mutation's own response carries no content — X answers
         * {"data":{"tweet_bookmark_put":"Done"}} and Reddit's /api/save is no
         * better — so this pulls the top page of the timeline instead, which
         * arrives with the whole item. One request, and the upsert makes the
         * overlap free.
         *
         * Debounced because saving three things in a row should cost one
         * sync, not three.
         */
        case "saved": {
          const pending = savedTimers.get(source);
          if (pending) clearTimeout(pending);
          savedTimers.set(
            source,
            setTimeout(() => {
              savedTimers.delete(source);
              void startCapture(source, true, true);
            }, 2500) as unknown as number,
          );
          break;
        }

        case "observed": {
          // A save happened in the UI, or a favourites page loaded a batch.
          await upload(source, msg.raw);
          const current = await readStatus(source);
          await patchStatus(source, {
            lastRun: Date.now(),
            items: current.items + Number(msg.items ?? 1),
          });
          break;
        }

        case "done":
          await patchStatus(source, {
            lastRun: Date.now(),
            pages: Number(msg.pages ?? 0),
            items: Number(msg.items ?? 0),
            message: Number(msg.items ?? 0) === 0 ? "run returned zero items" : null,
          });
          break;

        case "error":
          await patchStatus(source, { message: String(msg.message ?? "unknown error") });
          break;

        case "start": {
          const creds = await settings();
          if (!creds) {
            await patchStatus(source, { message: "enter the server and token, then press Save" });
            return;
          }
          await startCapture(source);
          break;
        }

        case "reschedule":
          await rescheduleAlarm();
          break;

        default:
          break;
      }
    })();

    return undefined;
  });

  /**
   * Automatic sync. Incremental by nature rather than by flag: every capture
   * path stops at the first page it has already seen, and the ingest upsert is
   * idempotent on (source, external_id), so a repeated run costs a request and
   * changes nothing.
   */
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void (async () => {
      const config = await loadConfig();
      for (const entry of config?.sources ?? []) {
        if (entry.mode !== "page") continue;
        await startCapture(entry.source, true);
      }
    })();
  });

  void rescheduleAlarm();

  // Arm the observers on every matching tab as it loads, so real-time capture
  // works without anyone opening the popup.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" || !tab.url) return;
    void loadConfig().then((config) => {
      for (const entry of config?.sources ?? []) {
        if (!tab.url?.includes(entry.host.replace("www.", ""))) continue;
        void browser.tabs.sendMessage(tabId, { anansi: "configure", config: entry }).catch(() => {});
      }
    });
  });
});
