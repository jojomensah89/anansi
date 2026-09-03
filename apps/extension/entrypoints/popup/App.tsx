import { useEffect, useState } from "react";
import type { RemoteConfig, SourceConfig, Status } from "../background.ts";

/**
 * Where to send things, how often, and one button per source.
 *
 * The source list is not hardcoded — it comes from the server's config, so a
 * source switched off in the web app disappears from here too. There is one
 * list of sources and the server owns it.
 */
const S = {
  ink: "#0b0e11",
  card: "#12161a",
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

export default function App() {
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [syncEvery, setSyncEvery] = useState(0);
  const [status, setStatus] = useState<Status>({});
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void browser.storage.local.get(["server", "token", "syncEvery", "status"]).then((s) => {
      setServer(String(s.server ?? ""));
      setToken(String(s.token ?? ""));
      setSyncEvery(Number(s.syncEvery ?? 0));
      setStatus((s.status as Status) ?? {});
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>) => {
      if (changes.status) setStatus((changes.status.newValue as Status) ?? {});
    };
    browser.storage.local.onChanged.addListener(onChange);
    return () => browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  // The source list is the server's, so it is fetched rather than assumed.
  useEffect(() => {
    if (!server.trim() || !token.trim()) return;
    fetch(`${server.replace(/\/+$/, "")}/api/extension/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => setConfig(c as RemoteConfig))
      .catch(() => setConfig(null));
  }, [server, token]);

  const save = async () => {
    await browser.storage.local.set({ server: server.replace(/\/+$/, ""), token, syncEvery });
    await browser.runtime.sendMessage({ anansi: "reschedule" });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const run = (source: string) => void browser.runtime.sendMessage({ anansi: "start", source });
  const configured = server.trim() !== "" && token.trim() !== "";

  return (
    <div style={{ width: 348, padding: 16, background: S.ink, color: S.text, fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={S.accent} strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7 5.6 5.6M14.3 9.7l4.1-4.1M9.7 14.3l-4.1 4.1M14.3 14.3l4.1 4.1" />
        </svg>
        <strong style={{ fontSize: 14 }}>Anansi</strong>
        {config && (
          <span style={{ marginLeft: "auto", fontFamily: S.mono, fontSize: 10, color: S.ok }}>
            connected
          </span>
        )}
      </div>

      <Label>Server</Label>
      <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://127.0.0.1:8788" style={input} />

      <Label>Ingest token</Label>
      <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="INGEST_TOKEN" style={input} />

      <Label>Sync automatically</Label>
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {INTERVALS.map((i) => (
          <button
            key={i.value}
            type="button"
            onClick={() => setSyncEvery(i.value)}
            style={{
              flex: 1,
              height: 27,
              borderRadius: 5,
              fontSize: 11.5,
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

      <button type="button" onClick={save} style={{ ...button, width: "100%", marginBottom: 14 }}>
        {saved ? "Saved" : "Save"}
      </button>

      {!configured && (
        <div style={{ fontSize: 11.5, color: S.faint, lineHeight: 1.5 }}>
          Enter your server and ingest token, then press Save.
        </div>
      )}

      {configured &&
        (config?.sources ?? []).map((s: SourceConfig) => {
          const st = status[s.source];
          const observe = s.mode === "observe";
          return (
            <div key={s.source} style={{ paddingTop: 11, marginTop: 11, borderTop: `1px solid ${S.line}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.host}</span>
                <span style={{ fontFamily: S.mono, fontSize: 9.5, padding: "1px 5px", borderRadius: 3, border: `1px solid ${S.edge}`, color: observe ? S.accent : S.faint }}>
                  {s.mode}
                </span>
                <button
                  type="button"
                  onClick={() => run(s.source)}
                  style={{
                    ...button,
                    marginLeft: "auto",
                    height: 27,
                    padding: "0 11px",
                    fontSize: 11.5,
                    // Observe-only sources have nothing to import; the button
                    // arms the watcher instead, and says so.
                    background: observe ? S.card : S.accent,
                    color: observe ? S.text : S.ink,
                    borderColor: observe ? S.edge : S.accent,
                    fontWeight: observe ? 400 : 600,
                  }}
                >
                  {observe ? "Watch" : "Import"}
                </button>
              </div>

              <div style={{ display: "flex", gap: 14, marginTop: 7, fontFamily: S.mono, fontSize: 10.5, color: S.faint }}>
                <span>{st?.items ?? 0} items</span>
                <span>{st?.uploaded ?? 0} sent</span>
                {(st?.failed ?? 0) > 0 && <span style={{ color: S.warn }}>{st?.failed} failed</span>}
                <span style={{ marginLeft: "auto" }}>
                  {st?.lastRun ? new Date(st.lastRun).toLocaleTimeString() : "never"}
                </span>
              </div>

              {st?.message && (
                <div style={{ marginTop: 7, fontFamily: S.mono, fontSize: 10, lineHeight: 1.5, color: st.message.includes("zero") || st.failed ? S.warn : S.muted }}>
                  {st.message}
                </div>
              )}
            </div>
          );
        })}

      <div style={{ marginTop: 14, paddingTop: 11, borderTop: `1px solid ${S.line}`, fontSize: 10.5, color: S.faint, lineHeight: 1.5 }}>
        Capture runs in your own logged-in tab, with the session the browser
        already has — so a sync needs that tab open. Nothing here ever sees a
        password.
      </div>
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  height: 30,
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
  height: 32,
  borderRadius: 5,
  border: `1px solid ${S.edge}`,
  background: S.card,
  color: S.text,
  fontSize: 12.5,
  cursor: "pointer",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: S.mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: S.faint, marginBottom: 5 }}>
      {children}
    </div>
  );
}
