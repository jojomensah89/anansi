import type {
  ExtensionRemoteConfig,
  ExtensionSourceConfig,
} from "@anansi/sources";
import { SourceMark } from "@anansi/ui/components/source-mark";
import { useCallback, useEffect, useState } from "react";
import { extensionConnection } from "../../lib/connection.ts";
import { MESSAGE_PROTOCOL_VERSION } from "../../lib/messages.ts";
import {
  CONNECTED_CONNECTION,
  connectionFromStatus,
  LOADING_CONNECTION,
  type PopupConnectionState,
  popupSourceRows,
  UNREACHABLE_CONNECTION,
  validatePopupRemoteConfig,
} from "../../lib/popup-connection.ts";
import {
  describeQueue,
  describeSource,
  redactError,
  type SourceSnapshot,
  type Tone,
  withoutStartingSource,
} from "../../lib/popup-state.ts";
import type { Status } from "../background.ts";
import "./App.css";

/**
 * The popup.
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

const NAMES: Record<string, string> = {
  x: "X bookmarks",
  reddit: "Reddit saves",
  github: "GitHub stars",
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

export default function App() {
  const [status, setStatus] = useState<Status>({});
  const [config, setConfig] = useState<ExtensionRemoteConfig | null>(null);
  const [connectionState, setConnectionState] = useState<PopupConnectionState>(LOADING_CONNECTION);
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshot, setSnapshot] = useState<DurableSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState<null | "saving" | "saved" | string>(null);
  const [mirroring, setMirroring] = useState<boolean | null>(null);
  const [mirrorNote, setMirrorNote] = useState<string | null>(null);
  const [startingSources, setStartingSources] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void mirror("mirror-status").then((r) => setMirroring(r?.mirroring ?? false));
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

  const { origin: base, token } = extensionConnection();

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
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | undefined;
    const load = async () => {
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
            setConnectionState(connectionFromStatus(configResponse.status));
          }
          return;
        }
        const nextConfig: unknown = await configResponse.json();
        if (!validatePopupRemoteConfig(nextConfig)) {
          if (current) {
            setConfig(null);
            setConnectionState({
              kind: "incompatible",
              message: "Incompatible server — update or redeploy Anansi",
            });
          }
          return;
        }
        if (current) {
          setConfig(nextConfig);
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
  }, [base, token, refresh]);

  // The worker's durable run record is authoritative once it exists. Until
  // then, keep an optimistic per-source label so a click has immediate proof
  // of life instead of waiting for the next polling cycle.
  useEffect(() => {
    if (!snapshot || startingSources.size === 0) return;
    const settled = new Set(startingSources);
    for (const source of startingSources) {
      const run = snapshot.runs[source];
      if (run?.phase === "running" || run?.lastErrorCode || run?.paused) settled.delete(source);
    }
    if (settled.size !== startingSources.size) setStartingSources(settled);
  }, [snapshot, startingSources]);
  const queue = snapshot?.queue ?? EMPTY_QUEUE;
  const outbox = describeQueue(queue);

  /**
   * Every source, including the ones the server has switched off.
   *
   * A switched-off source is simply absent from the config, and a row that
   * vanishes reads as a bug rather than a setting. So the known sources are
   * appended back, marked off, and say so.
   */
  const rows = popupSourceRows(config?.sources ?? null);

  /** Everything one row needs, entirely from persisted state. */
  const viewOf = (s: ExtensionSourceConfig & { enabled: boolean; configured: boolean }) => {
    if (!s.configured && config === null) {
      return {
        state: "ready" as const,
        text: connectionState.message,
        tone: connectionState.kind === "loading" ? ("faint" as const) : ("warn" as const),
        action: "none" as const,
        actionLabel: "Import",
        settled: false,
      };
    }
    const run = snapshot?.runs[s.source];
    const input: SourceSnapshot = {
      source: s.source,
      enabled: s.enabled,
      phase: run?.phase ?? "idle",
      startedAt: run?.startedAt,
      updatedAt: run?.updatedAt,
      paused: run?.paused,
      lastErrorCode: run?.lastErrorCode,
      queue: snapshot?.bySource?.[s.source] ?? EMPTY_QUEUE,
      lastRun: status[s.source]?.lastRun ?? null,
      held: stats?.bySource[s.source] ?? 0,
    };
    return describeSource(input, now);
  };

  const act = (s: ExtensionSourceConfig, action: string) => {
    if (action === "pause") return void pause(s.source);
    setStartingSources((previous) => new Set(previous).add(s.source));
    void start(s.source).then(
      () => setStartingSources((previous) => withoutStartingSource(previous, s.source)),
      () => setStartingSources((previous) => withoutStartingSource(previous, s.source)),
    );
  };

  /**
   * The one line that answers "is anything outstanding".
   *
   * Counted from the same persisted records the rows are, so it cannot
   * disagree with them.
   */
  const running = rows.filter((s) => viewOf(s).state === "running").length;
  const summary =
    running > 0 ? `${running} running` : outbox.total > 0 ? `${outbox.total} in the outbox` : "nothing waiting";

  // Whatever last went wrong, with anything credential-shaped removed.
  const diagnostics = [
    ...(connectionState.kind === "connected" || connectionState.kind === "loading"
      ? []
      : [`connection: ${connectionState.message}`]),
    ...Object.entries(status).flatMap(([source, st]) =>
      st.message && !(source === "_" && connectionState.kind === "connected")
        ? [`${source}: ${redactError(st.message)}`]
        : [],
    ),
  ];

  return (
    <div
      className="anansi-popup"
      style={{
        width: 344,
        background: S.ink,
        color: S.text,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px 0",
        }}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={S.accent}
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7 5.6 5.6M14.3 9.7l4.1-4.1M9.7 14.3l-4.1 4.1M14.3 14.3l4.1 4.1" />
        </svg>
        <strong style={{ fontSize: 14 }}>Anansi</strong>
      </div>

      <div
        style={{
          padding: "12px 16px 14px",
          display: "flex",
          alignItems: "baseline",
          gap: 9,
        }}
      >
        <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>
          {stats ? stats.items.toLocaleString() : "—"}
        </span>
        <span style={{ fontSize: 12.5, color: S.muted }}>saved items</span>
        {stats && stats.today > 0 && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: S.mono,
              fontSize: 11,
              color: S.ok,
              border: `1px solid ${S.edge}`,
              borderRadius: 20,
              padding: "3px 9px",
            }}
          >
            +{stats.today} today
          </span>
        )}
        {stats === null && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: S.mono,
              fontSize: 10.5,
              color: connectionState.kind === "loading" ? S.faint : S.warn,
            }}
          >
            {connectionState.message.toLowerCase()}
          </span>
        )}
      </div>

      {outbox.total > 0 && (
        <div
          style={{
            margin: "0 16px 12px",
            padding: "8px 10px",
            border: `1px solid ${queue.failed ? S.warn : S.edge}`,
            borderRadius: 7,
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: TONES[outbox.tone],
            fontSize: 10.5,
            fontFamily: S.mono,
          }}
        >
          <span>outbox · {outbox.text}</span>
          {outbox.canRetry && (
            <button
              type="button"
              onClick={() => void retry().then(refresh)}
              style={{
                ...button,
                marginLeft: "auto",
                height: 23,
                padding: "0 8px",
                fontSize: 10,
              }}
            >
              Retry all
            </button>
          )}
        </div>
      )}

      <div className="anansi-sources">
          {rows.map((s) => {
            const view = viewOf(s);
            const isStarting = startingSources.has(s.source) && view.action === "import";
            return (
            <div
              key={s.source}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "11px 16px",
                borderTop: `1px solid ${S.line}`,
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: S.raised,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  color: S.muted,
                }}
              >
                <SourceMark source={s.source} size={14} muted decorative />
              </span>
              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{NAMES[s.source] ?? s.host}</span>
                <span
                  style={{
                    fontSize: 11,
                    color: TONES[view.tone],
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {view.text}
                </span>
              </span>
              <button
                type="button"
                disabled={!s.configured || view.action === "none" || isStarting}
                onClick={() => act(s, view.action)}
                aria-label={`${isStarting ? "Starting" : view.actionLabel} ${NAMES[s.source] ?? s.host}`}
                aria-busy={isStarting}
                style={{
                  ...button,
                  height: 27,
                  padding: "0 12px",
                  fontSize: 11.5,
                  flexShrink: 0,
                  opacity: !s.configured || view.action === "none" || isStarting ? 0.65 : 1,
                  cursor: !s.configured || view.action === "none" || isStarting ? "default" : "pointer",
                  background: view.action === "pause" ? S.raised : S.card,
                  color: view.action === "pause" ? S.faint : S.text,
                }}
              >
                {isStarting && <span className="anansi-spinner" aria-hidden="true" />}
                {isStarting ? "Starting…" : view.actionLabel}
              </button>
            </div>
          );
        })}
        {/*
            The page you are on. Not a platform row — there is nothing to
            import and nothing to watch — so it says what it does and offers
            the one action it has.
          */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "11px 16px",
            borderTop: `1px solid ${S.line}`,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: S.raised,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: S.muted,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
            </svg>
          </span>
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
              flex: 1,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>This page</span>
            <span
              style={{
                fontSize: 11,
                color: saving === "saved" ? S.ok : saving && saving !== "saving" ? S.warn : S.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {saving === "saving"
                ? "Saving…"
                : saving === "saved"
                  ? "Saved to your library"
                  : (saving ?? "Save this page, or right-click a selection")}
            </span>
          </span>
          <button
            type="button"
            disabled={saving === "saving"}
            onClick={async () => {
              setSaving("saving");
              const result = (await savePage()) as
                | {
                    ok?: boolean;
                    delivery?: "queued" | "uploaded";
                    error?: string;
                  }
                | undefined;
              setSaving(
                result?.ok
                  ? result.delivery === "uploaded"
                    ? "saved"
                    : "Saved on this device; waiting to upload"
                  : (result?.error ?? "could not save that page"),
              );
              setTimeout(() => setSaving(null), 4000);
              refresh();
            }}
            style={{
              ...button,
              height: 27,
              padding: "0 12px",
              fontSize: 11.5,
              flexShrink: 0,
            }}
          >
            Save
          </button>
        </div>

        {/*
            Chrome, kept separate from the sources above and from "This page".
            It is not a platform being watched and not a page being clipped —
            it is the browser's own list, mirrored only if you ask, and the
            permission arrives when you do.
          */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "11px 16px",
            borderTop: `1px solid ${S.line}`,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: S.raised,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: S.muted,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 4h12v17l-6-4-6 4z" />
            </svg>
          </span>
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
              flex: 1,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Chrome bookmarks</span>
            <span
              style={{
                fontSize: 11,
                color: mirrorNote ? S.warn : mirroring ? S.faint : S.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {mirrorNote ??
                (mirroring === null
                  ? "Checking…"
                  : mirroring
                    ? "Mirroring — new bookmarks arrive as you make them"
                    : "Off. Turning it on asks Chrome for access")}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={mirroring === true}
            aria-label="Mirror Chrome bookmarks"
            disabled={mirroring === null}
            onClick={async () => {
              setMirrorNote(null);
              const next = !mirroring;
              const result = await mirror(next ? "mirror-on" : "mirror-off");
              setMirroring(result?.mirroring ?? false);
              if (result?.error) setMirrorNote(result.error);
              refresh();
            }}
            style={{
              width: 36,
              height: 20,
              flexShrink: 0,
              borderRadius: 10,
              padding: "0 2px",
              display: "flex",
              alignItems: "center",
              justifyContent: mirroring ? "flex-end" : "flex-start",
              background: mirroring ? "#2a3f36" : S.raised,
              border: `1px solid ${mirroring ? "#3d6353" : S.edge}`,
              cursor: mirroring === null ? "default" : "pointer",
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: mirroring ? S.ok : S.faint,
              }}
            />
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "11px 16px",
          borderTop: `1px solid ${S.line}`,
        }}
      >
        <span className="mono" style={{ fontSize: 10.5, color: S.faintest, fontFamily: S.mono }}>
          {summary}
        </span>
        <button
          type="button"
          onClick={() => void browser.tabs.create({ url: new URL("/", base).toString() })}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            cursor: "pointer",
            font: "inherit",
            fontSize: 11.5,
            color: S.accent,
          }}
        >
          Open library ↗
        </button>
      </div>

      {diagnostics.length > 0 && (
        <details className="anansi-diagnostics" style={{ borderTop: `1px solid ${S.line}`, padding: "9px 16px 12px" }}>
          <summary style={{ fontSize: 10.5, color: S.faint, fontFamily: S.mono }}>Details</summary>
          <div
            style={{
              marginTop: 7,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {diagnostics.map((line) => (
              <div
                key={line}
                style={{
                  fontSize: 10.5,
                  fontFamily: S.mono,
                  color: S.muted,
                  lineHeight: 1.45,
                  wordBreak: "break-word",
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const button: React.CSSProperties = {
  height: 31,
  borderRadius: 5,
  border: `1px solid ${S.edge}`,
  background: S.card,
  color: S.text,
  fontSize: 12.5,
  cursor: "pointer",
};
