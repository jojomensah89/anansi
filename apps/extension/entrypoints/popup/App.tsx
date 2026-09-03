import { useEffect, useState } from "react";
import type { RemoteConfig, SourceConfig, Status } from "../background.ts";

/**
 * The popup.
 *
 * Shaped after [removed]'s, which gets one thing right that a row of counters
 * does not: the question you open this for is "is it working", and a number
 * only answers that if you remember what it was last time. So each source
 * says its state in words — up to date, never imported, watching, or what
 * went wrong — and the raw counts sit underneath for when the words are not
 * enough.
 *
 * The source list comes from the server's config, so a source switched off in
 * the web app disappears from here too. There is one list and the server owns
 * it.
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
  accent: "#e4a33c",
  ok: "#4fbf8b",
  warn: "#e0714f",
  mono: "ui-monospace, 'IBM Plex Mono', monospace",
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

interface DurableSnapshot {
  queue: QueueStatus;
  runs: Record<string, { phase: "idle" | "running"; startedAt?: number }>;
}

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

const run = (source: string) =>
  void browser.runtime.sendMessage({ anansi: "start", source });

/** Stop persists through the background run coordinator before the UI changes. */
const stop = (source: string) =>
  void browser.runtime.sendMessage({ anansi: "stop", source });

const retryQueue = () =>
  void browser.runtime.sendMessage({ anansi: "retry-queue" });

export default function App() {
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [syncEvery, setSyncEvery] = useState(0);
  const [status, setStatus] = useState<Status>({});
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({
    queued: 0,
    uploading: 0,
    retrying: 0,
    failed: 0,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void browser.storage.local.get(["server", "token", "syncEvery", "status", "queueStatus"]).then((s) => {
      const hasServer = !!String(s.server ?? "").trim();
      setServer(String(s.server ?? ""));
      setToken(String(s.token ?? ""));
      setSyncEvery(Number(s.syncEvery ?? 0));
      setStatus((s.status as Status) ?? {});
      if (s.queueStatus) setQueueStatus(s.queueStatus as QueueStatus);
      // First run opens on the settings, every run after that on the sources.
      setSettingsOpen(!hasServer);
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>) => {
      if (changes.status) setStatus((changes.status.newValue as Status) ?? {});
      if (changes.queueStatus) {
        setQueueStatus((changes.queueStatus.newValue as QueueStatus) ?? {
          queued: 0,
          uploading: 0,
          retrying: 0,
          failed: 0,
        });
      }
    };
    browser.storage.local.onChanged.addListener(onChange);
    return () => browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  const base = server.replace(/\/+$/, "");
  useEffect(() => {
    if (!base || !token.trim()) return;
    const load = () => {
      fetch(`${base}/api/extension/config`).then((r) => (r.ok ? r.json() : null)).then(setConfig).catch(() => setConfig(null));
      fetch(`${base}/api/stats`).then((r) => (r.ok ? r.json() : null)).then(setStats).catch(() => setStats(null));
      void browser.runtime.sendMessage({ anansi: "queue-status" }).then((response) => {
        const snapshot = (response as { ok?: boolean; snapshot?: DurableSnapshot } | undefined)?.snapshot;
        if (!snapshot) return;
        setQueueStatus(snapshot.queue);
        setStatus((current) => {
          const next = { ...current };
          for (const [source, run] of Object.entries(snapshot.runs)) {
            next[source] = {
              ...(next[source] ?? { lastRun: null, pages: 0, items: 0, uploaded: 0, failed: 0, message: null }),
              startedAt: run.phase === "running" ? run.startedAt ?? null : null,
            };
          }
          return next;
        });
      }).catch(() => {});
    };
    load();
    // Refresh while a run is in flight, so the numbers move as it works.
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [base, token]);

  const save = async () => {
    await browser.storage.local.set({ server: base, token, syncEvery });
    await browser.runtime.sendMessage({ anansi: "reschedule" });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const configured = base !== "" && token.trim() !== "";

  /**
   * Is a run actually in flight, or did one die without saying so?
   *
   * Judged here rather than in the background worker, because MV3 kills an
   * idle service worker after about thirty seconds — a timer there usually
   * never fires, which is how "importing…" got written to storage and stayed
   * there through reloads and restarts.
   */
  const RUN_TIMEOUT_MS = 90_000;
  const runState = (st: Status[string] | undefined) => {
    if (!st?.startedAt) return "idle" as const;
    return Date.now() - st.startedAt < RUN_TIMEOUT_MS ? ("running" as const) : ("stalled" as const);
  };

  /** What to say about a source, in words rather than numbers. */
  const describe = (s: SourceConfig) => {
    const st = status[s.source];
    const held = stats?.bySource[s.source] ?? 0;
    const state = runState(st);

    if (state === "running") {
      const seen = (st?.items ?? 0) > 0 ? ` · ${st?.items} so far` : "";
      return { text: `Importing${seen}`, tone: S.accent };
    }
    if (state === "stalled") {
      return { text: "Stopped responding — press Import to retry", tone: S.warn };
    }
    if (st?.message && st.message !== "running…" && st.message !== "scanning…") {
      return { text: st.message, tone: st.failed ? S.warn : S.muted };
    }
    if (held > 0) {
      const when = st?.lastRun ? ` · synced ${new Date(st.lastRun).toLocaleTimeString()}` : "";
      return { text: `${held.toLocaleString()} saved${when}`, tone: S.faint };
    }
    return { text: "Ready to import", tone: S.muted };
  };

  return (
    <div style={{ width: 344, background: S.ink, color: S.text, fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
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

      {configured && (queueStatus.queued + queueStatus.uploading + queueStatus.retrying + queueStatus.failed > 0) && (
        <div style={{ margin: "0 16px 12px", padding: "8px 10px", border: `1px solid ${queueStatus.failed ? S.warn : S.edge}`, borderRadius: 7, display: "flex", alignItems: "center", gap: 8, color: queueStatus.failed ? S.warn : S.muted, fontSize: 10.5, fontFamily: S.mono }}>
          <span>
            outbox {queueStatus.queued + queueStatus.uploading + queueStatus.retrying} pending
            {queueStatus.failed > 0 ? ` · ${queueStatus.failed} failed` : ""}
          </span>
          {queueStatus.failed > 0 && (
            <button type="button" onClick={retryQueue} style={{ ...button, marginLeft: "auto", height: 23, padding: "0 8px", fontSize: 10 }}>
              Retry
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
            A scheduled sync needs that site's tab open — capture runs there,
            with the session your browser already has. Saving something syncs it
            straight away either way.
          </div>
          <button type="button" onClick={save} style={{ ...button, width: "100%" }}>
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      )}

      {configured &&
        (config?.sources ?? []).map((s) => {
          const st = status[s.source];
          const d = describe(s);
          const running = runState(st) === "running";
          return (
            <div key={s.source} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 16px", borderTop: `1px solid ${S.line}` }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: S.raised, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: S.muted }}>
                <Mark source={s.source} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{NAMES[s.source] ?? s.host}</span>
                <span style={{ fontSize: 11, color: d.tone, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.text}
                </span>
              </span>
              <button
                type="button"
                onClick={() => (running ? stop(s.source) : run(s.source))}
                style={{
                  ...button,
                  height: 27,
                  padding: "0 12px",
                  fontSize: 11.5,
                  flexShrink: 0,
                  background: running ? S.raised : S.card,
                  color: running ? S.faint : S.text,
                }}
              >
                {running ? "Stop" : "Import"}
              </button>
            </div>
          );
        })}

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
