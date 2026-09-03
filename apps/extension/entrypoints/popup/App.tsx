import { useEffect, useState } from "react";
import type { Status } from "../background.ts";

/**
 * The whole UI: where to send things, and a button.
 *
 * Deliberately plain. The extension is a pipe, and a pipe with a settings
 * panel is a pipe that has started to become an app — which is the thing the
 * thin-pipe design exists to avoid, because every feature here is a feature
 * that has to pass review and cannot be fixed server-side.
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

export default function App() {
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void browser.storage.local.get(["server", "token", "status"]).then((s) => {
      setServer(String(s.server ?? ""));
      setToken(String(s.token ?? ""));
      setStatus((s.status as Status) ?? null);
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>) => {
      if (changes.status) setStatus(changes.status.newValue as Status);
    };
    browser.storage.local.onChanged.addListener(onChange);
    return () => browser.storage.local.onChanged.removeListener(onChange);
  }, []);

  const save = async () => {
    await browser.storage.local.set({ server: server.replace(/\/+$/, ""), token });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const run = () => void browser.runtime.sendMessage({ anansi: "start" });

  const configured = server.trim() !== "" && token.trim() !== "";

  return (
    <div
      style={{
        width: 320,
        padding: 16,
        background: S.ink,
        color: S.text,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={S.accent} strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7 5.6 5.6M14.3 9.7l4.1-4.1M9.7 14.3l-4.1 4.1M14.3 14.3l4.1 4.1" />
        </svg>
        <strong style={{ fontSize: 14 }}>Anansi</strong>
      </div>

      <Label>Server</Label>
      <input
        value={server}
        onChange={(e) => setServer(e.target.value)}
        placeholder="http://127.0.0.1:8788"
        style={input}
      />

      <Label>Ingest token</Label>
      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        type="password"
        placeholder="INGEST_TOKEN"
        style={input}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} style={{ ...button, flex: 1 }}>
          {saved ? "Saved" : "Save"}
        </button>
        <button
          type="button"
          onClick={run}
          disabled={!configured}
          style={{
            ...button,
            flex: 2,
            background: configured ? S.accent : S.card,
            color: configured ? S.ink : S.faint,
            borderColor: configured ? S.accent : S.edge,
            cursor: configured ? "pointer" : "not-allowed",
            fontWeight: 600,
          }}
        >
          Import bookmarks
        </button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${S.line}` }}>
        <Row k="pages" v={String(status?.pages ?? 0)} />
        <Row k="items" v={String(status?.items ?? 0)} />
        <Row k="uploaded" v={String(status?.uploaded ?? 0)} />
        <Row k="failed" v={String(status?.failed ?? 0)} tone={status?.failed ? S.warn : undefined} />
        <Row
          k="last run"
          v={status?.lastRun ? new Date(status.lastRun).toLocaleTimeString() : "never"}
        />
      </div>

      {status?.message && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 5,
            background: S.card,
            border: `1px solid ${S.edge}`,
            fontFamily: S.mono,
            fontSize: 10.5,
            color: status.message.includes("zero") || status.failed ? S.warn : S.muted,
            lineHeight: 1.5,
          }}
        >
          {status.message}
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 10.5, color: S.faint, lineHeight: 1.5 }}>
        Runs in your own logged-in tab, with the session the browser already
        has. Nothing here ever sees a password.
      </div>
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "0 9px",
  marginBottom: 8,
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
    <div
      style={{
        fontFamily: S.mono,
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: S.faint,
        marginBottom: 5,
      }}
    >
      {children}
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontFamily: S.mono,
        fontSize: 11,
        marginBottom: 4,
      }}
    >
      <span style={{ color: S.faint }}>{k}</span>
      <span style={{ color: tone ?? S.muted }}>{v}</span>
    </div>
  );
}
