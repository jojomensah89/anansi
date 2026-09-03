import { useCallback, useEffect, useState } from "react";
import type { RemoteConfig, SourceConfig, Status } from "../background.ts";
import { MESSAGE_PROTOCOL_VERSION } from "../../lib/messages.ts";
import {
  describeQueue,
  describeSource,
  redactError,
  type SourceSnapshot,
  type Tone,
} from "../../lib/popup-state.ts";
import "./App.css";

/**
 * The popup.
 *
 * Shaped after [removed]'s, which gets one thing right that a row of counters
 * does not: the question you open this for is "is it working", and a number
 * only answers that if you remember what it was last time.
 *
 * So each source says its state in words — but the words are derived, here,
 * from durable run records and durable outbox counts, and never read out of a
 * message the background left in storage. That distinction is the whole point
 * of this file: "running…" used to be a string that outlived the run that
 * wrote it, survived reloads and browser restarts, and made the only question
 * worth asking unanswerable. A source can no longer claim to be synced while
 * anything is still queued, retrying or failed for it.
 *
 * The source list comes from the server's config — one list, server-owned.
 * A source switched off there keeps its row and says it is off, because a row
 * that silently vanishes reads as a bug rather than as a setting.
 */
const S = {
  ink: "#0b0e11",
  card: "#12161a",
  raised: "#171d23",
  line: "#1f262d",
  edge: "#232a31",
  text: "#e6ebef",
  muted: "#8d9aa6",
  faint: "#5d6874",
  faintest: "#414a53",
  accent: "#e4a33c",
  ok: "#4fbf8b",
  warn: "#e0714f",
  mono: "ui-monospace, 'IBM Plex Mono', monospace",
};

const TONES: Record<Tone, string> = {
  accent: S.accent,
  ok: S.ok,
  warn: S.warn,
  muted: S.muted,
  faint: S.faint,
};

const INTERVALS = [
  { value: 0, label: "off" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 360, label: "6h" },
  { value: 1440, label: "daily" },
];

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
  paused?: boolean;
  lastErrorCode?: string;
}

interface DurableSnapshot {
  queue: QueueStatus;
  bySource: Record<string, QueueStatus>;
  runs: Record<string, RunRecord>;
}

const EMPTY_QUEUE: QueueStatus = {
  queued: 0,
  uploading: 0,
  retrying: 0,
  failed: 0,
};

/** What the server can offer. Anything missing from its config is switched off. */
const KNOWN_SOURCES = ["x", "reddit", "tiktok"];

const NAMES: Record<string, string> = {
  x: "Twitter / X",
  reddit: "Reddit",
  tiktok: "TikTok",
  github: "GitHub",
};

const MARK_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "currentColor",
} as const;

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

const retry = (source?: string) =>
  command(source ? { action: "retry-queue", source } : { action: "retry-queue" });

export default function App() {
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [syncEvery, setSyncEvery] = useState(0);
  const [status, setStatus] = useState<Status>({});
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshot, setSnapshot] = useState<DurableSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void browser.storage.local.get(["server", "token", "syncEvery", "status"]).then((s) => {
      const hasServer = !!String(s.server ?? "").trim();
      setServer(String(s.server ?? ""));
      setToken(String(s.token ?? ""));
      setSyncEvery(Number(s.syncEvery ?? 0));
      setStatus((s.status as Status) ?? {});
      // First run opens on the settings, every run after that on the sources.
      setSettingsOpen(!hasServer);
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>) => {
      if (changes.status) setStatus((changes.status.newValue as Status) ?? {});
    };
    browser.storage.local.onChanged.addListener(onChange);
    return () => browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  const base = server.replace(/\/+$/, "");

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
    if (!base || !token.trim()) return;
    const load = () => {
      fetch(`${base}/api/extension/config`).then((r) => (r.ok ? r.json() : null)).then(setConfig).catch(() => setConfig(null));
      fetch(`${base}/api/stats`).then((r) => (r.ok ? r.json() : null)).then(setStats).catch(() => setStats(null));
      refresh();
    };
    load();
    // Refresh while a run is in flight, so the numbers move as it works.
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [base, token, refresh]);

  const save = async () => {
    await browser.storage.local.set({ server: base, token, syncEvery });
    await command({ action: "reschedule" });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const configured = base !== "" && token.trim() !== "";
  const queue = snapshot?.queue ?? EMPTY_QUEUE;
  const outbox = describeQueue(queue);

  /**
   * Every source, including the ones the server has switched off.
   *
   * A switched-off source is simply absent from the config, and a row that
   * vanishes reads as a bug rather than a setting. So the known sources are
   * appended back, marked off, and say so.
   */
  const rows: Array<SourceConfig & { enabled: boolean }> = [
    ...(config?.sources ?? []).map((s) => ({ ...s, enabled: true })),
    ...KNOWN_SOURCES.filter(
      (source) => config && !config.sources.some((s) => s.source === source),
    ).map((source) => ({
      source,
      host: source,
      mode: "page" as const,
      enabled: false,
    })),
  ];

  /** Everything one row needs, entirely from persisted state. */
  const viewOf = (s: SourceConfig & { enabled: boolean }) => {
    const run = snapshot?.runs[s.source];
    const input: SourceSnapshot = {
      source: s.source,
      enabled: s.enabled,
      phase: run?.phase ?? "idle",
      startedAt: run?.startedAt,
      paused: run?.paused,
      lastErrorCode: run?.lastErrorCode,
      queue: snapshot?.bySource?.[s.source] ?? EMPTY_QUEUE,
      lastRun: status[s.source]?.lastRun ?? null,
      held: stats?.bySource[s.source] ?? 0,
    };
    return describeSource(input, now);
  };

  const act = (s: SourceConfig, action: string) => {
    if (action === "pause") return void pause(s.source);
    if (action === "retry") return void retry(s.source).then(refresh);
    if (action === "sign-in") return void browser.tabs.create({ url: `https://${s.host}` });
    return void start(s.source);
  };

  /**
   * The one line that answers "is anything outstanding".
   *
   * Counted from the same persisted records the rows are, so it cannot
   * disagree with them.
   */
  const running = rows.filter((s) => viewOf(s).state === "running").length;
  const summary =
    running > 0
      ? `${running} running`
      : outbox.total > 0
        ? `${outbox.total} in the outbox`
        : "nothing waiting";

  // Whatever last went wrong, with anything credential-shaped removed.
  const diagnostics = Object.entries(status)
    .filter(([, st]) => !!st.message)
    .map(([source, st]) => `${source}: ${redactError(st.message ?? "")}`);

  return (
    <div className="anansi-popup" style={{ width: 344, background: S.ink, color: S.text, fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 0" }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={S.accent} strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7 5.6 5.6M14.3 9.7l4.1-4.1M9.7 14.3l-4.1 4.1M14.3 14.3l4.1 4.1" />
        </svg>
        <strong style={{ fontSize: 14 }}>Anansi</strong>
        <button
          type="button"
          onClick={() => setSettingsOpen((o) => !o)}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: settingsOpen ? S.text : S.faint, padding: 2 }}
        >
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21 9h0a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 2z" />
          </svg>
        </button>
      </div>

      {configured && (
        <div style={{ padding: "12px 16px 14px", display: "flex", alignItems: "baseline", gap: 9 }}>
          <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {stats ? stats.items.toLocaleString() : "—"}
          </span>
          <span style={{ fontSize: 12.5, color: S.muted }}>saved</span>
          {stats && stats.today > 0 && (
            <span style={{ marginLeft: "auto", fontFamily: S.mono, fontSize: 11, color: S.ok, border: `1px solid ${S.edge}`, borderRadius: 20, padding: "3px 9px" }}>
              +{stats.today} today
            </span>
          )}
          {stats === null && (
            <span style={{ marginLeft: "auto", fontFamily: S.mono, fontSize: 10.5, color: S.warn }}>
              server unreachable
            </span>
          )}
        </div>
      )}

      {configured && outbox.total > 0 && (
        <div style={{ margin: "0 16px 12px", padding: "8px 10px", border: `1px solid ${queue.failed ? S.warn : S.edge}`, borderRadius: 7, display: "flex", alignItems: "center", gap: 8, color: TONES[outbox.tone], fontSize: 10.5, fontFamily: S.mono }}>
          <span>outbox · {outbox.text}</span>
          {outbox.canRetry && (
            <button type="button" onClick={() => void retry().then(refresh)} style={{ ...button, marginLeft: "auto", height: 23, padding: "0 8px", fontSize: 10 }}>
              Retry all
            </button>
          )}
        </div>
      )}

      {settingsOpen && (
        <div style={{ padding: "0 16px 14px", borderBottom: `1px solid ${S.line}` }}>
          <Label htmlFor="anansi-server">Server</Label>
          <input id="anansi-server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://127.0.0.1:8788" style={input} />
          <Label htmlFor="anansi-token">Ingest token</Label>
          <input id="anansi-token" value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="INGEST_TOKEN" style={input} />
          <Label>Sync automatically</Label>
          <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
            {INTERVALS.map((i) => (
              <button
                key={i.value}
                type="button"
                onClick={() => setSyncEvery(i.value)}
                aria-pressed={syncEvery === i.value}
                style={{
                  flex: 1,
                  height: 26,
                  borderRadius: 5,
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: S.mono,
                  background: syncEvery === i.value ? S.accent : S.card,
                  color: syncEvery === i.value ? S.ink : S.muted,
                  border: `1px solid ${syncEvery === i.value ? S.accent : S.edge}`,
                }}
              >
                {i.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: S.faint, lineHeight: 1.5, marginBottom: 10 }}>
            A scheduled sync opens the site in a background tab and closes it
            again, using the session your browser already has. Saving something
            syncs it straight away either way.
          </div>
          <button type="button" onClick={save} style={{ ...button, width: "100%" }}>
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      )}

      {configured && (
        <div className="anansi-sources">
          {rows.map((s) => {
            const view = viewOf(s);
            return (
              <div key={s.source} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 16px", borderTop: `1px solid ${S.line}` }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: S.raised, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: S.muted }}>
                  <Mark source={s.source} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{NAMES[s.source] ?? s.host}</span>
                  <span style={{ fontSize: 11, color: TONES[view.tone], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {view.text}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={view.action === "none"}
                  onClick={() => act(s, view.action)}
                  aria-label={`${view.actionLabel} ${NAMES[s.source] ?? s.host}`}
                  style={{
                    ...button,
                    height: 27,
                    padding: "0 12px",
                    fontSize: 11.5,
                    flexShrink: 0,
                    opacity: view.action === "none" ? 0.4 : 1,
                    cursor: view.action === "none" ? "default" : "pointer",
                    background: view.action === "pause" ? S.raised : S.card,
                    color: view.action === "pause" ? S.faint : S.text,
                  }}
                >
                  {view.actionLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {configured && (
        <div style={{ display: "flex", alignItems: "center", padding: "11px 16px", borderTop: `1px solid ${S.line}` }}>
          <span className="mono" style={{ fontSize: 10.5, color: S.faintest, fontFamily: S.mono }}>
            {summary}
          </span>
          <button
            type="button"
            onClick={() => void browser.tabs.create({ url: base })}
            style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", font: "inherit", fontSize: 11.5, color: S.accent }}
          >
            Open library ↗
          </button>
        </div>
      )}

      {configured && diagnostics.length > 0 && (
        <details className="anansi-diagnostics" style={{ borderTop: `1px solid ${S.line}`, padding: "9px 16px 12px" }}>
          <summary style={{ fontSize: 10.5, color: S.faint, fontFamily: S.mono }}>
            Details
          </summary>
          <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 5 }}>
            {diagnostics.map((line) => (
              <div key={line} style={{ fontSize: 10.5, fontFamily: S.mono, color: S.muted, lineHeight: 1.45, wordBreak: "break-word" }}>
                {line}
              </div>
            ))}
          </div>
        </details>
      )}

      {!configured && !settingsOpen && (
        <div style={{ padding: "0 16px 16px", fontSize: 12, color: S.faint, lineHeight: 1.5 }}>
          Open settings and enter your server address and ingest token.
        </div>
      )}
    </div>
  );
}

function Mark({ source }: { source: string }) {
  if (source === "reddit")
    return (
      <svg {...MARK_PROPS} aria-hidden="true">
        <path d="M22 12.06a2.19 2.19 0 0 0-3.7-1.56c-1.49-1.03-3.52-1.7-5.78-1.78l.99-4.62 3.23.69a1.56 1.56 0 1 0 .17-.95l-3.6-.77a.47.47 0 0 0-.56.36l-1.1 5.28c-2.3.06-4.37.73-5.88 1.78A2.18 2.18 0 0 0 2 12.06c0 .87.51 1.62 1.25 1.97a3.9 3.9 0 0 0-.05.63c0 3.2 3.83 5.8 8.55 5.8s8.55-2.6 8.55-5.8c0-.21-.02-.42-.05-.62A2.18 2.18 0 0 0 22 12.06zM7.4 13.6a1.56 1.56 0 1 1 3.12 0 1.56 1.56 0 0 1-3.12 0zm8.72 4.12c-1.07 1.07-3.1 1.15-3.7 1.15-.6 0-2.64-.08-3.7-1.15a.4.4 0 0 1 .57-.57c.67.67 2.1.91 3.13.91 1.04 0 2.47-.24 3.14-.91a.4.4 0 1 1 .56.57zm-.19-2.56a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12z" />
      </svg>
    );
  if (source === "tiktok")
    return (
      <svg {...MARK_PROPS} aria-hidden="true">
        <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .77-5.06v-3.1a5.66 5.66 0 0 0-.77-.05A5.66 5.66 0 1 0 15.54 15.4V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.29 4.29 0 0 1-3.24-1.48z" />
      </svg>
    );
  if (source === "github")
    return (
      <svg {...MARK_PROPS} aria-hidden="true">
        <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.2-3.37-1.2-.46-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
      </svg>
    );
  return (
    <svg {...MARK_PROPS} aria-hidden="true">
      <path d="M13.7 10.62 20.4 3h-1.59l-5.82 6.62L8.34 3H3l7.02 10.01L3 21h1.59l6.14-6.99L15.66 21H21l-7.3-10.38zm-2.17 2.47-.71-1L5.16 4.17h2.44l4.57 6.4.71 1 5.94 8.32h-2.44l-4.85-6.8z" />
    </svg>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  height: 29,
  padding: "0 9px",
  marginBottom: 9,
  background: S.card,
  border: `1px solid ${S.edge}`,
  borderRadius: 5,
  color: S.text,
  fontSize: 12,
  fontFamily: S.mono,
  outline: "none",
};

const button: React.CSSProperties = {
  height: 31,
  borderRadius: 5,
  border: `1px solid ${S.edge}`,
  background: S.card,
  color: S.text,
  fontSize: 12.5,
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = {
  fontFamily: S.mono,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: S.faint,
  marginBottom: 5,
};

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  if (htmlFor) {
    return <label htmlFor={htmlFor} style={labelStyle}>{children}</label>;
  }
  return (
    <div style={labelStyle}>
      {children}
    </div>
  );
}
