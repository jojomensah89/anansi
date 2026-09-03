/**
 * The background worker: the only part of the extension that knows a server
 * exists, and the only part that holds the token.
 *
 * The thin pipe in one place — fetch a config, hand it to the page, upload
 * whatever comes back untouched. There is no parsing here on purpose. When X
 * reshapes a response the fix ships server-side and every install is repaired
 * on its next run, which is what makes distributing this load-unpacked
 * reasonable rather than a maintenance trap.
 */

export interface Settings {
  /** e.g. http://127.0.0.1:8788 in development, your Worker in production. */
  server: string;
  token: string;
}

export interface SourceConfig {
  host: string;
  operation: string;
  variables: Record<string, unknown>;
  cursorPrefix: string;
  entryPrefix: string;
  pageLimit: number;
  watchOperations?: string[];
}

export interface RemoteConfig {
  version: number;
  enabled: boolean;
  ingest: string;
  sources: SourceConfig[];
}

export interface Status {
  lastRun: number | null;
  pages: number;
  items: number;
  uploaded: number;
  failed: number;
  message: string | null;
}

const CONFIG_TTL_MS = 60 * 60 * 1000;

let cached: { at: number; config: RemoteConfig } | null = null;

async function settings(): Promise<Settings | null> {
  const stored = await browser.storage.local.get(["server", "token"]);
  const server = String(stored.server ?? "").replace(/\/+$/, "");
  const token = String(stored.token ?? "");
  return server && token ? { server, token } : null;
}

async function setStatus(patch: Partial<Status>): Promise<void> {
  const current = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  await browser.storage.local.set({ status: { ...current, ...patch } });
}

/**
 * Revalidated hourly rather than fetched per run. It is also the kill switch:
 * `enabled: false` stops every install without anyone updating anything.
 */
async function loadConfig(force = false): Promise<RemoteConfig | null> {
  if (!force && cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
  const s = await settings();
  if (!s) return null;
  const url = `${s.server}/api/extension/config`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      // Almost always an older server still running on the port, which is
      // worth saying outright rather than reporting as a generic failure.
      throw new Error(`404 at ${url} — is an older Anansi server still on that port?`);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    const config = (await res.json()) as RemoteConfig;
    if (!Array.isArray(config.sources)) throw new Error(`unexpected config shape from ${url}`);
    cached = { at: Date.now(), config };
    return config;
  } catch (err) {
    await setStatus({ message: (err as Error).message });
    return cached?.config ?? null;
  }
}

/** Upload one untouched payload. The server does the understanding. */
async function upload(raw: unknown, source = "x"): Promise<void> {
  const s = await settings();
  const config = await loadConfig();
  if (!s || !config) return;

  const res = await fetch(config.ingest, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ source, raw }),
  });

  const current = ((await browser.storage.local.get("status")).status ?? {}) as Status;
  if (res.ok) {
    await setStatus({ uploaded: (current.uploaded ?? 0) + 1, message: null });
  } else {
    // 422 is the zero-parse alarm coming back from the server. It means the
    // payload shape changed, and it must be visible rather than swallowed.
    const body = await res.text().catch(() => "");
    await setStatus({
      failed: (current.failed ?? 0) + 1,
      message: `ingest ${res.status}: ${body.slice(0, 120)}`,
    });
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const msg = message as Record<string, unknown> | undefined;
    if (!msg?.anansi) return undefined;

    // Everything below arrives from a content script sharing a context with
    // x.com's own code. It is data, never instruction: the only thing done
    // with it is to forward it verbatim to the server.
    void (async () => {
      switch (msg.anansi) {
        case "page":
          await upload(msg.raw);
          await setStatus({ pages: Number(msg.page ?? 0), items: Number(msg.items ?? 0) });
          break;

        case "observed":
          // A bookmark was just created or removed in the UI. The response
          // body carries the change; the server works out what it means.
          await upload(msg.raw);
          break;

        case "done":
          await setStatus({
            lastRun: Date.now(),
            pages: Number(msg.pages ?? 0),
            items: Number(msg.items ?? 0),
            message: Number(msg.items ?? 0) === 0 ? "run returned zero items" : null,
          });
          break;

        case "error":
          await setStatus({ message: String(msg.message ?? "unknown error") });
          break;

        case "start": {
          // Popup asked for a backfill. Find the x.com tab and tell its MAIN
          // world script to go, with the config it should follow.
          //
          // Each failure gets its own message. An earlier version reported
          // every one of these as "not configured", which sent you looking at
          // the settings when the actual problem was a stale server.
          const creds = await settings();
          if (!creds) {
            await setStatus({ message: "enter the server and token, then press Save" });
            return;
          }
          await setStatus({ message: "checking server…" });
          const config = await loadConfig(true);
          if (!config) return; // loadConfig already said why
          if (!config.enabled) {
            await setStatus({ message: "disabled by server config" });
            return;
          }
          const source = config.sources[0];
          if (!source) return;
          const tabs = await browser.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
          const tab = tabs[0];
          if (!tab?.id) {
            await setStatus({ message: "open a logged-in x.com tab first" });
            return;
          }
          await setStatus({ pages: 0, items: 0, uploaded: 0, failed: 0, message: "running…" });
          await browser.tabs.sendMessage(tab.id, { anansi: "configure", config: source });
          await browser.tabs.sendMessage(tab.id, { anansi: "backfill", config: source });
          break;
        }

        default:
          break;
      }
      void sender;
    })();

    return undefined;
  });

  // Arm the observers on every x.com tab as it loads, so real-time capture
  // works without anyone opening the popup.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" || !tab.url?.includes("x.com")) return;
    void loadConfig().then((config) => {
      const source = config?.enabled ? config.sources[0] : undefined;
      if (source) {
        void browser.tabs.sendMessage(tabId, { anansi: "configure", config: source }).catch(() => {});
      }
    });
  });
});
