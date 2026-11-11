import { TIKTOK_SYNC_SETTING } from "../../lib/library-sync.ts";
import { retireOwnConnection } from "../../lib/library-connect.ts";
import { SAVE_CONFIRMATION_SETTING } from "../../lib/save-toast.ts";
import { parseExtensionConfig, type ExtensionRemoteConfig } from "@anansi/sources";
import { createPersistedConfigCache } from "../../lib/config-cache.ts";
import { SourceMark } from "@anansi/ui/components/source-mark";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { requireOriginPermission } from "../../lib/connection-lifecycle.ts";
import {
  clearExtensionConnection,
  type ExtensionConnection,
  getExtensionConnection,
  saveExtensionConnection,
  validateExtensionConnection,
} from "../../lib/connection.ts";
import { MESSAGE_PROTOCOL_VERSION } from "../../lib/messages.ts";
import {
  CONNECTED_CONNECTION,
  connectionFromStatus,
  LOADING_CONNECTION,
  type PopupConnectionState,
  type PopupSourceConfig,
  type PopupSourceRow,
  popupSourceRows,
  UNCONFIGURED_CONNECTION,
  UNREACHABLE_CONNECTION,
  validatePopupRemoteConfig,
} from "../../lib/popup-connection.ts";
import {
  describeQueue,
  describeSource,
  redactError,
  type SourceSnapshot,
  withoutStartingSource,
  initialImportSummary,
} from "../../lib/popup-state.ts";
import { sourceRowView, type SourceRowView } from "../../lib/popup-view.ts";
import type { Status } from "../background.ts";
import { Icon } from "./icons.tsx";
import "./App.css";

/**
 * The popup.
 *
 * It leads with the page you are on, because saving it is the thing done most
 * often. Below that, two tabs: Sources (each platform, its state in a few
 * words, and the one action that makes sense right now) and Options.
 *
 * Every word about a source is derived here from durable run records and
 * durable outbox counts, never read out of a message the background left in
 * storage: "running…" used to be a string that outlived the run that wrote
 * it. A source can no longer claim to be up to date while anything is still
 * queued, retrying or failed for it.
 *
 * The source list comes from the server's config. A source switched off keeps
 * its row with its switch off, because a row that silently vanishes reads as a
 * bug rather than as a setting. The switch flips at once and is put back, with
 * a word on the row, if the library refuses.
 */

interface Stats {
  items: number;
  today: number;
  bySource: Record<string, number>;
}

interface QueueStatus {
  queued: number;
  uploading: number;
  retrying: number;
  failed: number;
}

interface RunRecord {
  phase: "idle" | "running";
  startedAt?: number;
  updatedAt?: number;
  paused?: boolean;
  lastErrorCode?: string;
  initialImportCompletedAt?: number;
}

interface DurableSnapshot {
  queue: QueueStatus;
  bySource: Record<string, QueueStatus>;
  runs: Record<string, RunRecord>;
  destinationOrigin?: string | null;
}

interface ActivePage {
  title: string;
  host: string;
  savable: boolean;
}

type Saving = null | "saving" | "saved" | "queued" | { error: string };
type Tab = "sources" | "options";

const EMPTY_QUEUE: QueueStatus = {
  queued: 0,
  uploading: 0,
  retrying: 0,
  failed: 0,
};

const SOURCE_NAMES: Record<string, string> = {
  x: "X",
  reddit: "Reddit",
  github: "GitHub",
  tiktok: "TikTok",
};

const command = (message: Record<string, unknown>) =>
  browser.runtime
    .sendMessage({
      anansi: "popup-command",
      messageVersion: MESSAGE_PROTOCOL_VERSION,
      ...message,
    })
    .catch(() => undefined);

const start = (source: string) => command({ action: "start", source });

/**
 * Pause, not stop.
 *
 * Progress and everything already queued survive; only the run in flight ends.
 * Calling it Stop implied it threw work away, which it never did.
 */
const pause = (source: string) => command({ action: "stop", source });

const savePage = () => command({ action: "save-page" });

const mirror = (action: "mirror-status" | "mirror-on" | "mirror-off") =>
  command({ action }) as Promise<{ ok?: boolean; mirroring?: boolean; error?: string } | undefined>;

const retry = (source?: string) => command(source ? { action: "retry-queue", source } : { action: "retry-queue" });

/** The worker sends this with the stored key and re-reads its config before answering. */
const setSourceEnabled = (source: string, enabled: boolean) =>
  command({ action: "set-source", source, enabled }) as Promise<{ ok?: boolean; enabled?: boolean } | undefined>;

/** The worker's last accepted config, read only to show where switches were left while offline. */
const lastAcceptedConfig = createPersistedConfigCache<ExtensionRemoteConfig>({
  storage: {
    get: (key) => browser.storage.local.get(key),
    set: (values) => browser.storage.local.set(values),
    remove: (key) => browser.storage.local.remove(key),
  },
  validate: (value) => {
    const parsed = parseExtensionConfig(value);
    return parsed.ok ? parsed.config : null;
  },
});

/** A flip the popup shows before the polled config agrees with it. */
interface SwitchOverride {
  enabled: boolean;
  /** The request is still out. */
  pending: boolean;
  /** When the flip was made or confirmed; a config read begun later supersedes it. */
  since: number;
}

function describePage(tab: { title?: string; url?: string } | undefined): ActivePage | null {
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    const savable = url.protocol === "http:" || url.protocol === "https:";
    const host = savable ? url.hostname.replace(/^www\./, "") : "";
    return { title: tab.title?.trim() || host || "This page", host, savable };
  } catch {
    return null;
  }
}

function sentenceCase(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export default function App() {
  const [status, setStatus] = useState<Status>({});
  const [config, setConfig] = useState<ExtensionRemoteConfig | null>(null);
  const [connectionState, setConnectionState] = useState<PopupConnectionState>(LOADING_CONNECTION);
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshot, setSnapshot] = useState<DurableSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [page, setPage] = useState<ActivePage | null>(null);
  const [saving, setSaving] = useState<Saving>(null);
  const [tab, setTab] = useState<Tab>("sources");
  const [mirroring, setMirroring] = useState<boolean | null>(null);
  const [mirrorNote, setMirrorNote] = useState<string | null>(null);
  const [startingSources, setStartingSources] = useState<Set<string>>(() => new Set());
  const [pausingSources, setPausingSources] = useState<Set<string>>(() => new Set());
  const [isRetrying, setIsRetrying] = useState(false);
  const [saveConfirmations, setSaveConfirmations] = useState(false);
  const [syncTiktok, setSyncTiktok] = useState(false);
  const [lastKnown, setLastKnown] = useState<readonly PopupSourceConfig[] | null>(null);
  const [switches, setSwitches] = useState<Record<string, SwitchOverride>>({});
  const [switchErrors, setSwitchErrors] = useState<Set<string>>(() => new Set());
  const [reloadNonce, setReloadNonce] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = errorTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  useEffect(() => {
    void mirror("mirror-status").then((r) => setMirroring(r?.mirroring ?? false));
  }, []);

  useEffect(() => {
    void browser.storage.local
      .get(SAVE_CONFIRMATION_SETTING)
      .then((stored) => setSaveConfirmations(stored[SAVE_CONFIRMATION_SETTING] === true));
    void browser.storage.local
      .get(TIKTOK_SYNC_SETTING)
      .then((stored) => setSyncTiktok(stored[TIKTOK_SYNC_SETTING] === true));
  }, []);

  // The page Save acts on. The popup only reads its title and address.
  useEffect(() => {
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([active]) => setPage(describePage(active)))
      .catch(() => setPage(null));
    return () => clearTimeout(saveTimer.current);
  }, []);

  useEffect(() => {
    void browser.storage.local.get("status").then((s) => {
      setStatus((s.status as Status) ?? {});
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>) => {
      if (changes.status) setStatus((changes.status.newValue as Status) ?? {});
    };
    browser.storage.local.onChanged.addListener(onChange);
    return () => browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  const [connection, setConnection] = useState<ExtensionConnection | null>(null);
  const [showXRisk, setShowXRisk] = useState(false);
  useEffect(() => {
    if (!connection) return;
    void browser.storage.local.get("anansiXRiskSeen").then((state) => {
      if (!state.anansiXRiskSeen) {
        setShowXRisk(true);
        void browser.storage.local.set({ anansiXRiskSeen: true });
      }
    });
  }, [connection]);
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [legacyQueueNeedsDecision, setLegacyQueueNeedsDecision] = useState(false);
  const [resolvingLegacyQueue, setResolvingLegacyQueue] = useState(false);

  useEffect(() => {
    void getExtensionConnection().then((conn) => {
      setConnectionLoaded(true);
      if (conn) {
        setConnection(conn);
        // The stored key never goes in the form: pasting a code into a masked,
        // filled field joins the two, and resubmitting it can only fail.
        setUrlInput(conn.origin);
      } else {
        setConnectionState(UNCONFIGURED_CONNECTION);
      }
    });
  }, []);

  useEffect(() => {
    if (!connection || !snapshot || snapshot.destinationOrigin) return;
    const pending = Object.values(snapshot.bySource).some((row) =>
      row.queued + row.uploading + row.retrying + row.failed > 0,
    );
    if (pending) {
      setLegacyQueueNeedsDecision(true);
      setShowSettings(true);
    }
  }, [connection, snapshot]);

  /**
   * Ask the worker what is actually persisted.
   *
   * Not a cached copy in storage: the snapshot is read from the outbox and the
   * run records at the moment it is asked for, so what the popup shows is what
   * would survive a restart.
   */
  const refresh = useCallback(() => {
    setNow(Date.now());
    void command({ action: "queue-status" }).then((response) => {
      const next = (response as { snapshot?: DurableSnapshot } | undefined)?.snapshot;
      if (next) setSnapshot(next);
    });
  }, []);

  useEffect(() => {
    if (!connection) {
      if (connectionLoaded) {
        setConnectionState((prev) =>
          prev.kind !== "unconfigured" ? UNCONFIGURED_CONNECTION : prev,
        );
      }
      return;
    }
    const { origin: base, token } = connection;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | undefined;
    // Where the switches were left, until the first live read answers.
    void lastAcceptedConfig
      .load(base, token, Date.now())
      .then((stored) => {
        if (current && stored) setLastKnown((previous) => previous ?? stored.value.sources);
      })
      .catch(() => {});
    const load = async () => {
      const startedAt = Date.now();
      requestController = new AbortController();
      const requestTimeout = setTimeout(() => requestController?.abort(), 10_000);
      try {
        const options = {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error" as const,
          signal: requestController.signal,
        };
        const configResponse = await fetch(`${base}/api/extension/config`, options);
        if (!configResponse.ok) {
          if (current) {
            setConfig(null);
            setStats(null);
            const state = connectionFromStatus(configResponse.status);
            setConnectionState(state.kind === "unauthorized"
              ? { ...state, message: "Key rejected. Check INGEST_TOKEN or ANANSI_SECRET on the server" }
              : state);
          }
          return;
        }
        const nextConfig: unknown = await configResponse.json();
        if (!validatePopupRemoteConfig(nextConfig)) {
          if (current) {
            setConfig(null);
            setConnectionState({
              kind: "incompatible",
              message: "Incompatible server. Update or redeploy Anansi",
            });
          }
          return;
        }
        if (current) {
          setConfig(nextConfig);
          setLastKnown(nextConfig.sources);
          // A read begun after a confirmed flip already reflects it.
          setSwitches((previous) => {
            const kept = Object.entries(previous).filter(([, flip]) => flip.pending || flip.since > startedAt);
            return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
          });
          setConnectionState(CONNECTED_CONNECTION);
        }

        const statsResponse = await fetch(`${base}/api/extension/stats`, options);
        if (current) {
          setStats(statsResponse.ok ? ((await statsResponse.json()) as Stats) : null);
        }
      } catch {
        if (current) {
          setConfig(null);
          setStats(null);
          setConnectionState(UNREACHABLE_CONNECTION);
        }
      } finally {
        clearTimeout(requestTimeout);
        requestController = undefined;
        if (current) {
          refresh();
          timer = setTimeout(() => void load(), 4000);
        }
      }
    };
    void load();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
      requestController?.abort();
    };
  }, [connection, connectionLoaded, refresh, reloadNonce]);

  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsConnecting(true);
    setConnectError(null);
    let permissionWasPresent = false;
    let permissionOrigin: string | null = null;
    let connectionSucceeded = false;
    try {
      let validated = validateExtensionConnection(urlInput, tokenInput);
      permissionOrigin = validated.origin;
      const previousSnapshot = await command({ action: "queue-status" });
      const currentSnapshot = (previousSnapshot as { snapshot?: DurableSnapshot } | undefined)?.snapshot;
      const pending = currentSnapshot?.bySource
        ? Object.values(currentSnapshot.bySource).reduce((total, queued) =>
          total + queued.queued + queued.uploading + queued.retrying + queued.failed, 0)
        : 0;
      const importRunning = Object.values(currentSnapshot?.runs ?? {}).some((run) => run.phase === "running");
      if (connection && connection.origin !== validated.origin &&
        ((pending > 0 && currentSnapshot?.destinationOrigin && currentSnapshot.destinationOrigin !== validated.origin) || importRunning)) {
        setConnectError("Pending captures or imports belong to your current library. Let them finish there before switching");
        return;
      }

      permissionWasPresent = await requireOriginPermission(
        validated.origin,
        browser.permissions,
      );
      const redemption = await fetch(`${validated.origin}/api/connect/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: validated.token }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (redemption.ok) {
        const issued = await redemption.json() as { key?: unknown };
        validated = validateExtensionConnection(validated.origin, issued.key);
      }
      const res = await fetch(`${validated.origin}/api/extension/config`, {
        headers: { Authorization: `Bearer ${validated.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        setConnectError("That code was rejected. It may have expired or been used. Get a new one in Anansi under Sources, Connect extension");
        return;
      }
      if (res.status === 404) {
        setConnectError("No Anansi library at this address");
        return;
      }
      if (!res.ok) {
        setConnectError(`The library answered with HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!validatePopupRemoteConfig(data)) {
        setConnectError("Incompatible server. Update or redeploy Anansi");
        return;
      }
      await browser.storage.local.set({
        anansiConnectionAttemptOrigin: validated.origin,
        ...(connection?.origin ? { anansiConnectionPreviousOrigin: connection.origin } : {}),
      });
      await saveExtensionConnection(validated.origin, validated.token);
      const updated = await command({ action: "connection-updated" }) as { ok?: boolean; error?: string; code?: string } | undefined;
      if (!updated?.ok) {
        if (updated?.code === "legacy_queue_unowned") {
          setConnection(validated);
          setConfig(data);
          setConnectionState(CONNECTED_CONNECTION);
          setShowSettings(true);
          setLegacyQueueNeedsDecision(true);
          setConnectError(updated.error ?? "Choose where pending captures go");
          connectionSucceeded = true;
          return;
        }
        if (connection) await saveExtensionConnection(connection.origin, connection.token);
        else await clearExtensionConnection();
        await browser.storage.local.remove(["anansiConnectionPreviousOrigin", "anansiConnectionAttemptOrigin"]);
        await command({ action: "connection-updated" });
        setConnectError(updated?.error ?? "Could not update the connection. Try again");
        return;
      }
      setConnection(validated);
      setConfig(data);
      setLastKnown(data.sources);
      setSwitches({});
      setConnectionState(CONNECTED_CONNECTION);
      setLegacyQueueNeedsDecision(false);
      setShowSettings(false);
      setTokenInput("");
      refresh();
      connectionSucceeded = true;
    } catch (err) {
      setConnectError((err as Error).message || "Could not reach the library");
    } finally {
      if (!connectionSucceeded) {
        await browser.storage.local.remove(["anansiConnectionPreviousOrigin", "anansiConnectionAttemptOrigin"]);
      }
      if (!connectionSucceeded && permissionOrigin && !permissionWasPresent && permissionOrigin !== connection?.origin) {
        // A failed connection should not leave a newly requested grant behind.
        void browser.permissions?.remove({ origins: [`${permissionOrigin}/*`] }).catch(() => {});
      }
      setIsConnecting(false);
    }
  };

  const adoptLegacyQueue = async () => {
    setResolvingLegacyQueue(true);
    try {
      const result = await command({ action: "adopt-legacy-queue" }) as { ok?: boolean; error?: string } | undefined;
      if (!result?.ok) {
        setConnectError(result?.error ?? "Could not assign the pending captures");
        return;
      }
      setLegacyQueueNeedsDecision(false);
      setConnectError(null);
      const response = await command({ action: "queue-status" }) as { snapshot?: DurableSnapshot } | undefined;
      if (response?.snapshot) setSnapshot(response.snapshot);
    } finally {
      setResolvingLegacyQueue(false);
    }
  };

  const handleDisconnect = async () => {
    // Best effort, so a key this browser just gave up doesn't stay active.
    if (connection) await retireOwnConnection(connection);
    await clearExtensionConnection();
    await command({ action: "connection-updated" });
    setConnection(null);
    setConfig(null);
    setLastKnown(null);
    setSwitches({});
    setStats(null);
    setConnectionState(UNCONFIGURED_CONNECTION);
    setShowSettings(false);
    setUrlInput("");
    setTokenInput("");
  };

  // The worker's durable run record is authoritative once it exists. Until
  // then, keep an optimistic per-source label so a click has immediate proof
  // of life instead of waiting for the next polling cycle.
  useEffect(() => {
    if (!snapshot || startingSources.size === 0) return;
    const settled = new Set(startingSources);
    for (const source of startingSources) {
      const run = snapshot.runs[source];
      if (
        run?.phase === "running" ||
        run?.lastErrorCode ||
        run?.paused ||
        run?.initialImportCompletedAt !== undefined
      )
        settled.delete(source);
    }
    if (settled.size !== startingSources.size) setStartingSources(settled);
  }, [snapshot, startingSources]);

  // If a start does not settle within 6 seconds, unlock the buttons anyway.
  useEffect(() => {
    if (startingSources.size === 0) return;
    const timer = setTimeout(() => {
      setStartingSources(new Set());
    }, 6000);
    return () => clearTimeout(timer);
  }, [startingSources]);

  const queue = snapshot?.queue ?? EMPTY_QUEUE;
  const outbox = describeQueue(queue);

  /**
   * Every source, including the ones the server has switched off.
   *
   * A switched-off source is simply absent from the config, and a row that
   * vanishes reads as a bug rather than a setting. So the known sources are
   * appended back, marked off, and say so.
   */
  const rows = popupSourceRows(config?.sources ?? null, lastKnown);
  const initialImport = initialImportSummary(rows, snapshot?.runs ?? null);

  /**
   * Flip a source's capture switch.
   *
   * Shown at once; the worker sends it and re-reads its own config so capture
   * starts or stops right away. A refusal puts the switch back and says so on
   * the row for a few seconds.
   */
  const toggleSource = (source: string, enabled: boolean) => {
    clearTimeout(errorTimers.current.get(source));
    setSwitchErrors((previous) => withoutStartingSource(previous, source));
    setSwitches((previous) => ({ ...previous, [source]: { enabled, pending: true, since: Date.now() } }));
    void setSourceEnabled(source, enabled).then((result) => {
      if (result?.ok && result.enabled === enabled) {
        setSwitches((previous) => ({ ...previous, [source]: { enabled, pending: false, since: Date.now() } }));
        // Read the config now so the row's action follows the switch.
        setReloadNonce((n) => n + 1);
        return;
      }
      setSwitches((previous) => {
        const { [source]: _dropped, ...rest } = previous;
        return rest;
      });
      setSwitchErrors((previous) => new Set(previous).add(source));
      errorTimers.current.set(
        source,
        setTimeout(() => setSwitchErrors((previous) => withoutStartingSource(previous, source)), 4000),
      );
    });
  };

  /** Everything one row shows, entirely from persisted state. */
  const rowOf = (s: PopupSourceRow): SourceRowView => {
    const name = SOURCE_NAMES[s.source] ?? s.host;
    const run = snapshot?.runs[s.source];
    const sourceQueue = snapshot?.bySource?.[s.source] ?? EMPTY_QUEUE;
    const offline = !s.configured && config === null;
    const flip = switches[s.source];
    const input: SourceSnapshot = {
      source: s.source,
      enabled: s.enabled,
      phase: run?.phase ?? "idle",
      startedAt: run?.startedAt,
      updatedAt: run?.updatedAt,
      paused: run?.paused,
      lastErrorCode: run?.lastErrorCode,
      queue: sourceQueue,
      lastRun: status[s.source]?.lastRun ?? null,
      held: stats?.bySource[s.source] ?? 0,
    };
    const view = describeSource(input, now);
    return sourceRowView({
      view: offline ? { ...view, state: "ready" } : view,
      name,
      initialImportDue: initialImport.due.includes(s.source),
      lastErrorCode: run?.lastErrorCode,
      queueFailed: sourceQueue.failed,
      progress: {
        pages: status[s.source]?.pages ?? 0,
        items: status[s.source]?.items ?? 0,
      },
      offline,
      toggleable: s.toggleable,
      enabled: flip?.enabled ?? s.enabled,
      switching: flip?.pending,
      switchFailed: switchErrors.has(s.source),
    });
  };

  const act = (source: string, action: SourceRowView["action"]) => {
    if (action === "pause") {
      setPausingSources((previous) => new Set(previous).add(source));
      void pause(source).finally(() => {
        setPausingSources((previous) => withoutStartingSource(previous, source));
        refresh();
      });
      return;
    }
    if (action !== "import") return;
    setStartingSources((previous) => new Set(previous).add(source));
    void start(source).then(
      () => setStartingSources((previous) => withoutStartingSource(previous, source)),
      () => setStartingSources((previous) => withoutStartingSource(previous, source)),
    );
  };

  const onSave = async () => {
    clearTimeout(saveTimer.current);
    setSaving("saving");
    const result = (await savePage()) as
      | { ok?: boolean; delivery?: "queued" | "uploaded"; error?: string }
      | undefined;
    setSaving(
      result?.ok
        ? result.delivery === "uploaded"
          ? "saved"
          : "queued"
        : { error: sentenceCase(result?.error ?? "Could not save this page") },
    );
    saveTimer.current = setTimeout(() => setSaving(null), 4000);
    refresh();
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Tab = event.key === "Home" ? "sources" : event.key === "End" ? "options" : tab === "sources" ? "options" : "sources";
    setTab(next);
    document.getElementById(`anansi-tab-${next}`)?.focus();
  };

  const toggleMirror = async () => {
    setMirrorNote(null);
    const next = !mirroring;
    const result = await mirror(next ? "mirror-on" : "mirror-off");
    setMirroring(result?.mirroring ?? false);
    if (result?.error) setMirrorNote(sentenceCase(result.error));
    refresh();
  };

  // Per-source failures, with anything credential-shaped removed. Server and
  // connection failures already show in the banner above, so they stay out.
  const diagnostics = Object.entries(status).flatMap(([source, st]) =>
    st.message && source !== "_"
      ? [`${SOURCE_NAMES[source] ?? source}: ${redactError(st.message)}`]
      : [],
  );

  const connectionProblem =
    connection && connectionState.kind !== "connected" && connectionState.kind !== "loading"
      ? connectionState.message
      : null;

  const inSettings = connectionLoaded && (!connection || showSettings);

  const header = inSettings && connection ? (
    <header className="pop-head with-back">
      <button
        type="button"
        className="btn ghost icon-only"
        aria-label="Back"
        onClick={() => {
          setConnectError(null);
          setShowSettings(false);
        }}
      >
        <Icon name="back" />
      </button>
      <span className="name">Connection</span>
    </header>
  ) : (
    <header className="pop-head">
      <img className="logo" src="/icon/48.png" width="20" height="20" alt="" aria-hidden="true" />
      <span className="name">Anansi</span>
      {connection && (
        <>
          <button
            type="button"
            className="btn ghost icon-only end"
            aria-label="Connection settings"
            title="Connection settings"
            onClick={() => {
              setConnectError(null);
              setShowSettings(true);
            }}
          >
            <Icon name="sliders" />
          </button>
        </>
      )}
    </header>
  );

  if (!connectionLoaded) {
    return (
      <div className="anansi-popup">
        {header}
        <div className="loading meta">Connecting…</div>
      </div>
    );
  }

  if (inSettings) {
    return (
      <div className="anansi-popup">
        {header}
        <form className="connect" onSubmit={handleConnect}>
          {!connection && (
            <div>
              <div className="heading">Connect to your library</div>
              <div className="meta">Get a code in Anansi under Sources, Connect extension</div>
            </div>
          )}

          <div className="field">
            <label htmlFor="anansi-worker-url">Library address</label>
            <input
              id="anansi-worker-url"
              className="input mono"
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://anansi.example.dev"
              autoComplete="url"
              spellCheck={false}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="anansi-worker-token">Code or capture key</label>
            <input
              id="anansi-worker-token"
              className="input mono"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste the code"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>

          {connectError && !legacyQueueNeedsDecision && (
            <div className="notice" role="alert">
              <Icon name="alert" />
              <span className="body">{connectError}</span>
            </div>
          )}

          {legacyQueueNeedsDecision && connection && (
            <div className="notice">
              <Icon name="alert" />
              <span className="body">
                Older pending captures have no recorded library, so delivery is paused. Assign them to {connection.origin.replace(/^https?:\/\//, "")} only if this is the library they belong to
                {connectError && <span className="meta" style={{ display: "block", marginTop: 4, color: "inherit" }}>{connectError}</span>}
                <button
                  type="button"
                  className="btn sm block"
                  disabled={resolvingLegacyQueue}
                  aria-busy={resolvingLegacyQueue}
                  onClick={() => void adoptLegacyQueue()}
                >
                  {resolvingLegacyQueue ? "Assigning…" : "Assign pending captures here"}
                </button>
              </span>
            </div>
          )}

          <div className="actions">
            <button type="submit" className="btn primary" disabled={isConnecting} aria-busy={isConnecting}>
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
            {connection && (
              <button type="button" className="btn" onClick={() => void handleDisconnect()}>
                Disconnect
              </button>
            )}
          </div>
          {connection && <p className="meta" style={{ margin: 0 }}>Pending captures stay on this device until you reconnect</p>}
        </form>
      </div>
    );
  }

  const saveLabel =
    saving === "saving"
      ? "Saving…"
      : saving === "saved"
        ? "Saved to your library"
        : saving === "queued"
          ? "Saved on this device"
          : "Save this page";
  const saved = saving === "saved" || saving === "queued";
  const saveNote =
    saving === "queued"
      ? { text: "Waiting to upload", tone: "" }
      : saving && typeof saving === "object"
        ? { text: saving.error, tone: "warn" }
        : page && !page.savable
          ? { text: "Only web pages can be saved", tone: "" }
          : { text: "Or right-click a selection", tone: "" };

  const footerText = stats
    ? `${stats.items.toLocaleString("en-US")} ${stats.items === 1 ? "save" : "saves"}${stats.today > 0 ? ` · +${stats.today.toLocaleString("en-US")} today` : ""}`
    : connectionState.kind === "loading"
      ? "Loading…"
      : "";

  return (
    <div className="anansi-popup">
      {header}

      <section className="save-card" aria-label="This page">
        <div className="page-line">
          <Icon name="globe" />
          <div className="page-text">
            <div className="page-title" title={page?.title}>{page?.title ?? "This page"}</div>
            {page?.host && page.host !== page.title && <div className="page-host meta">{page.host}</div>}
          </div>
        </div>
        <button
          type="button"
          className={saved ? "btn block" : "btn primary block"}
          disabled={saving === "saving" || saved || page?.savable === false}
          aria-busy={saving === "saving"}
          onClick={() => void onSave()}
        >
          <Icon name={saved ? "check" : "bookmarkPlus"} />
          {saveLabel}
        </button>
        <div className={`save-note meta ${saveNote.tone}`} role={saveNote.tone === "warn" ? "alert" : undefined} aria-live="polite">
          {saveNote.text}
        </div>
      </section>

      <div className="tabs" role="tablist" aria-label="Popup sections" onKeyDown={onTabKey}>
        {(["sources", "options"] as const).map((name) => (
          <button
            key={name}
            id={`anansi-tab-${name}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === name}
            aria-controls={`anansi-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
          >
            {name === "sources" ? "Sources" : "Options"}
          </button>
        ))}
      </div>

      {tab === "sources" ? (
        <div className="panel" id="anansi-panel-sources" role="tabpanel" aria-labelledby="anansi-tab-sources">
          {connectionProblem && (
            <div className="notice" role="alert">
              <Icon name="alert" />
              <span className="body">{connectionProblem}</span>
            </div>
          )}

          {outbox.total > 0 && (
            <div className={`notice notice-row${queue.failed ? "" : " neutral"}`}>
              <span className="body">{sentenceCase(outbox.text)}</span>
              {outbox.canRetry && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={isRetrying}
                  aria-busy={isRetrying}
                  onClick={async () => {
                    setIsRetrying(true);
                    try {
                      await retry();
                      refresh();
                    } finally {
                      setIsRetrying(false);
                    }
                  }}
                >
                  {isRetrying ? "Retrying…" : "Retry all"}
                </button>
              )}
            </div>
          )}

          {showXRisk && (
            <div className="notice neutral" role="note">
              <span className="body">
                Checking X may open a background tab. Automated visits can put your X account at risk
                <button
                  type="button"
                  className="btn sm"
                  style={{ display: "flex" }}
                  onClick={() => {
                    setShowXRisk(false);
                    void browser.storage.local.set({ anansiXRiskSeen: true });
                  }}
                >
                  Got it
                </button>
              </span>
            </div>
          )}

          <div>
            {rows.map((s) => {
              const row = rowOf(s);
              const name = SOURCE_NAMES[s.source] ?? s.host;
              const busy =
                row.action === "import"
                  ? startingSources.has(s.source)
                  : row.action === "pause" && pausingSources.has(s.source);
              return (
                <div key={s.source} className="srow" data-tone={row.tone} data-off={row.switch?.checked === false || undefined}>
                  <span className="mark">
                    <SourceMark source={s.source} size={20} decorative />
                  </span>
                  <div className="text">
                    <div className="title">{name}</div>
                    {row.status && (
                      <div className="status" data-tone={row.tone} role={row.switch && switchErrors.has(s.source) ? "alert" : undefined}>
                        {row.status}
                      </div>
                    )}
                  </div>
                  {row.label && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={row.action === "none" || busy}
                      aria-busy={busy}
                      aria-label={`${busy ? row.busyLabel.replace("…", "") : row.label}, ${name}`}
                      onClick={() => act(s.source, row.action)}
                    >
                      {row.action === "pause" && !busy && <Icon name="pause" />}
                      {row.label === "Resume" && !busy && <Icon name="play" />}
                      {busy ? row.busyLabel : row.label}
                    </button>
                  )}
                  {row.switch && (
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={row.switch.checked}
                      aria-label={row.switch.label}
                      disabled={row.switch.disabled}
                      aria-busy={switches[s.source]?.pending || undefined}
                      onClick={() => toggleSource(s.source, !row.switch!.checked)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="panel" id="anansi-panel-options" role="tabpanel" aria-labelledby="anansi-tab-options">
          {/*
              Chrome's own bookmark list, mirrored only if you ask; the
              permission is requested when you switch it on and handed back
              when you switch it off.
            */}
          <div className="opt">
            <div className="text">
              <div className="title" id="opt-mirror">Chrome bookmarks</div>
              <div className={mirrorNote ? "meta warn" : "meta"}>
                {mirrorNote ??
                  (mirroring === null
                    ? "Checking…"
                    : mirroring
                      ? "On · new bookmarks arrive as you make them"
                      : "Off · asks Chrome for access when switched on")}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={mirroring === true}
              aria-labelledby="opt-mirror"
              disabled={mirroring === null}
              onClick={() => void toggleMirror()}
            />
          </div>

          <div className="opt">
            <div className="text">
              <div className="title" id="opt-confirm">Save confirmations</div>
              <div className="meta">{saveConfirmations ? "Shown beside the button you pressed" : "Off · errors still show"}</div>
            </div>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={saveConfirmations}
              aria-labelledby="opt-confirm"
              onClick={() => {
                const next = !saveConfirmations;
                setSaveConfirmations(next);
                void browser.storage.local.set({ [SAVE_CONFIRMATION_SETTING]: next });
              }}
            />
          </div>

          <div className="opt">
            <div className="text">
              <div className="title" id="opt-tiktok">Check TikTok when the library opens</div>
              <div className="meta">Opens a TikTok window briefly. Automated visits can put your account at risk</div>
            </div>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={syncTiktok}
              aria-labelledby="opt-tiktok"
              onClick={() => {
                const next = !syncTiktok;
                setSyncTiktok(next);
                void browser.storage.local.set({ [TIKTOK_SYNC_SETTING]: next });
              }}
            />
          </div>

          <p className="opt-note meta" style={{ margin: 0 }}>
            Opening your library checks X, Reddit and GitHub for new saves
          </p>
        </div>
      )}

      {diagnostics.length > 0 && (
        <details className="details">
          <summary>
            <Icon name="chevronRight" />
            Details
          </summary>
          <ul>
            {diagnostics.map((line) => (
              <li key={line} className="meta">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="pop-foot">
        <span className="meta num">{footerText}</span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            if (connection) void browser.tabs.create({ url: new URL("/", connection.origin).toString() });
          }}
        >
          Open library
          <Icon name="arrowUpRight" />
        </button>
      </footer>
    </div>
  );
}
