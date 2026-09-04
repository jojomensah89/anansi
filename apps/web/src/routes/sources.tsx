import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { SourceCardsSkeleton, useSlowLoad } from "../components/skeleton.tsx";
import { api, type SourceRow } from "../lib/api.ts";
import { useHideRemoved } from "../lib/settings.ts";

export const Route = createFileRoute("/sources")({ component: Sources });

/**
 * Where each source stands.
 *
 * A library is an ongoing process, not a pile, and the question you actually
 * have is "is this still working?" — which no grid of cards answers. So this
 * leads with capture health rather than a connect button, because the failure
 * this project most needs to notice is an import that quietly returns nothing.
 *
 * The split bar is the distinction Anansi can make and most tools cannot: an
 * item either has a real saved-at from the extension watching it happen, or an
 * import stamp. Colour alone would not carry that, so it is labelled.
 *
 * Sources with nothing in them are still listed, with their capture mode
 * stated. "Observe" is not a lesser version of "page" — it is the only thing
 * possible for a platform that publishes no history endpoint, and saying so is
 * better than letting an empty card read as broken.
 */
/**
 * Three ways a source can be captured, and they are not ranked.
 *
 * `page` means the extension can walk your whole history itself. `observe`
 * means the platform publishes no history endpoint and signs its own requests,
 * so capture happens by watching what its app fetches. `cli` means it is not
 * an extension source at all — GitHub has a real API and a revocable token, so
 * it is imported from the command line. `manual` means nothing is watched at
 * all: a page is here because you pressed something.
 */
type Mode = "page" | "observe" | "cli" | "manual";

interface Known {
  name: string;
  source: string;
  mode: Mode;
  /** What it captures, and how, when there is nothing here yet. */
  note: string;
}

/**
 * Every source the app knows about, whether or not it has anything in it.
 *
 * The rail lists all four unconditionally, so a source with no rows vanishing
 * from this page left the two disagreeing — which reads as a source that is
 * broken rather than one you simply have not imported yet.
 */
const KNOWN: Known[] = [
  {
    name: "X bookmarks",
    source: "x",
    mode: "page",
    note: "Ready to capture your bookmarks as soon as the extension runs an import.",
  },
  {
    name: "GitHub stars",
    source: "github",
    mode: "cli",
    note:
      "Imported from the command line rather than by the extension — GitHub has a real API and a token you can scope and revoke, so there is no reason to scrape it. Run `anansi import github` with a fine-grained token in .env.",
  },
  {
    name: "Reddit saves",
    source: "reddit",
    mode: "page",
    note: "Ready to capture saved posts and comments as soon as the extension runs an import.",
  },
  {
    name: "TikTok favourites",
    source: "tiktok",
    mode: "observe",
    note:
      "No history endpoint and signed requests, so there is no import to press: your favourites arrive as the extension watches the page load them.",
  },
  {
    name: "Web pages & bookmarks",
    source: "web",
    mode: "manual",
    note:
      "Nothing is watched here — a page arrives because you saved it from the toolbar, right-clicked a selection, or turned on Chrome bookmark mirroring in the extension popup.",
  },
];

const NAMES: Record<string, string> = {
  x: "X bookmarks",
  github: "GitHub stars",
  reddit: "Reddit saves",
  tiktok: "TikTok favourites",
  web: "Web pages & bookmarks",
};

const MODES: Record<string, Mode> = Object.fromEntries(KNOWN.map((k) => [k.source, k.mode]));

const STALE_AFTER = 7 * 86400;

function ago(unix: number | null): string {
  if (!unix) return "never";
  const mins = Math.round((Date.now() - unix * 1000) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type Tab = "all" | "capturing" | "planned";

function Sources() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [hideRemoved, setHideRemoved] = useHideRemoved();
  const [stats, setStats] = useState<{ items: number; authors: number; bySource: Record<string, number> }>({
    items: 0,
    authors: 0,
    bySource: {},
  });

  const toggle = (source: string, enabled: boolean) => {
    // Optimistic: the switch is the whole interaction, and waiting a round
    // trip to move it makes it feel broken.
    setSources((prev) => prev.map((s) => (s.source === source ? { ...s, enabled } : s)));
    api.toggleSource(source, enabled).catch(() => {
      setSources((prev) => prev.map((s) => (s.source === source ? { ...s, enabled: !enabled } : s)));
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.stats(controller.signal), api.sources(controller.signal)])
      .then(([s, r]) => {
        setStats({ items: s.items, authors: s.authors, bySource: s.bySource });
        setSources(r.sources);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Health has to be fetched before anything here is true, and an empty grid
  // in the meantime reads as "no sources" rather than "not yet".
  const ready = sources.length > 0;
  const slow = useSlowLoad(!ready);

  const empty = useMemo(
    () => KNOWN.filter((k) => !sources.some((s) => s.source === k.source)),
    [sources],
  );

  const showCapturing = tab !== "planned";
  /*
    Not until the health has arrived. `empty` is derived from what came back,
    so before it does every source looks empty — and a section confidently
    listing X under "nothing captured yet", beside a rail saying 1,274, is a
    worse answer than no section at all.
  */
  const showEmpty = tab !== "capturing" && ready && empty.length > 0;

  return (
    <div style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
      <Rail total={stats.items} authors={stats.authors} bySource={stats.bySource} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            height: 52,
            flexShrink: 0,
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 22px",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Sources</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            where everything came from, and whether it still works
          </span>

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 2,
              padding: 2,
              background: "var(--card)",
              border: "1px solid var(--edge)",
              borderRadius: 6,
            }}
          >
            {(
              [
                ["all", "All"],
                ["capturing", "Capturing"],
                ["planned", "Nothing yet"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-pressed={tab === value}
                style={{
                  height: 24,
                  padding: "0 11px",
                  borderRadius: 4,
                  border: "none",
                  background: tab === value ? "var(--raised)" : "transparent",
                  color: tab === value ? "var(--text)" : "var(--muted)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="scroll" style={{ flex: 1, padding: "18px 22px 60px" }}>
          {/*
            The extension is what every source below depends on, so it leads.
            It is stated rather than checked: the web app cannot see the
            extension, and a green dot it cannot verify would be a lie.
          */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "13px 16px",
              marginBottom: 16,
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--raised)",
                border: "1px solid var(--edge)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 4a2 2 0 1 1 4 0v2h3a1 1 0 0 1 1 1v3h2a2 2 0 1 1 0 4h-2v3a1 1 0 0 1-1 1h-3v-2a2 2 0 1 0-4 0v2H7a1 1 0 0 1-1-1v-3H4a2 2 0 1 1 0-4h2V7a1 1 0 0 1 1-1h3z" />
              </svg>
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>Anansi extension</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                captures every source below, using the sessions your browser already has
              </span>
            </span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--fainter)" }}>
              check the toolbar popup for its status
            </span>
          </div>

          {showCapturing && !ready && slow && <SourceCardsSkeleton />}

          {showCapturing && ready && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
                gap: 14,
              }}
            >
              {sources.map((s) => (
                <SourceCard key={s.source} row={s} onToggle={toggle} />
              ))}
            </div>
          )}

          {showEmpty && (
            <>
              <div
                className="mono"
                style={{
                  marginTop: showCapturing ? 28 : 0,
                  marginBottom: 12,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--fainter)",
                }}
              >
                Nothing captured yet
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
                  gap: 14,
                }}
              >
                {empty.map((p) => (
                  <div
                    key={p.source}
                    style={{
                      background: "var(--card)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                      padding: 16,
                      opacity: 0.62,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <Badge source={p.source} />
                      <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                          nothing captured yet
                        </span>
                      </span>
                      <Mode mode={p.mode} push />
                    </div>
                    <div style={{ fontSize: 12, color: "var(--faint)", lineHeight: 1.55 }}>
                      {p.note}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/*
            The one preference this page owns. It belongs here rather than in
            the filter bar because it is not a question about this view — it is
            a standing answer about what the library is for.
          */}
          <div
            style={{
              marginTop: 24,
              padding: "13px 16px",
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              gap: 14,
              maxWidth: 640,
            }}
          >
            <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                Hide items removed at the source
              </span>
              <span style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.5 }}>
                Unsaving something on a platform never deletes it here. Leave this off to keep
                everything you ever saved, marked when the platform no longer has it; turn it on
                for a library that mirrors what is currently saved.
              </span>
            </span>
            <button
              type="button"
              onClick={() => setHideRemoved(!hideRemoved)}
              role="switch"
              aria-checked={hideRemoved}
              aria-label="Hide items removed at the source"
              style={{
                width: 36,
                height: 20,
                flexShrink: 0,
                borderRadius: 10,
                padding: "0 2px",
                display: "flex",
                alignItems: "center",
                justifyContent: hideRemoved ? "flex-end" : "flex-start",
                background: hideRemoved ? "#2a3f36" : "var(--raised)",
                border: `1px solid ${hideRemoved ? "#3d6353" : "var(--edge)"}`,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: hideRemoved ? "var(--ok)" : "var(--faint)",
                }}
              />
            </button>
          </div>

          <div
            style={{
              marginTop: 18,
              fontSize: 12,
              color: "var(--faint)",
              lineHeight: 1.6,
              maxWidth: 640,
            }}
          >
            <strong style={{ color: "var(--muted)", fontWeight: 500 }}>page</strong> means the
            extension can walk your whole history itself.{" "}
            <strong style={{ color: "var(--accent)", fontWeight: 500 }}>observe</strong> means the
            platform publishes no history endpoint and signs its own requests, so capture happens by
            watching what the app fetches — pressing Import on TikTok opens your favourites and
            scrolls them, rather than requesting a list nobody serves.{" "}
            <strong style={{ color: "var(--muted)", fontWeight: 500 }}>cli</strong> means the
            extension is not involved at all: GitHub has a real API and a token you can scope and
            revoke, so it is imported by command rather than scraped.{" "}
            <strong style={{ color: "var(--muted)", fontWeight: 500 }}>manual</strong> means nothing
            is watched — a web page is here because you saved it.
          </div>
        </div>
      </div>
    </div>
  );
}

function Badge({ source }: { source: string }) {
  return (
    <span
      style={{
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 7,
        border: "1px solid var(--edge-strong)",
        color: "var(--text-dim)",
        flexShrink: 0,
      }}
    >
      <SourceMark source={source} size={15} />
    </span>
  );
}

function Mode({ mode, push }: { mode: Mode; push?: boolean }) {
  return (
    <span
      className="mono"
      style={{
        marginLeft: push ? "auto" : undefined,
        fontSize: 9.5,
        padding: "2px 6px",
        borderRadius: 3,
        border: "1px solid var(--edge)",
        color: mode === "observe" ? "var(--accent)" : "var(--faint)",
        fontStyle: mode === "cli" || mode === "manual" ? "italic" : undefined,
      }}
    >
      {mode}
    </span>
  );
}

function SourceCard({ row, onToggle }: { row: SourceRow; onToggle: (source: string, enabled: boolean) => void }) {
  const off = row.enabled === false;
  const stale = row.lastSavedAt !== null && Date.now() / 1000 - row.lastSavedAt > STALE_AFTER;
  const mode = MODES[row.source] ?? "page";

  return (
    <div
      style={{
        background: "var(--card)",
        border: `1px solid ${stale && !off ? "#4a3c22" : "var(--line)"}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        // Dimmed, never hidden: an absent source reads as broken.
        opacity: off ? 0.55 : 1,
      }}
    >
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Badge source={row.source} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>
              {NAMES[row.source] ?? row.source}
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
              {row.items.toLocaleString()} items · {row.authors} authors
            </span>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {!off && (
              <span
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 10.5,
                  color: stale ? "var(--accent)" : "var(--ok)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: stale ? "var(--accent)" : "var(--ok)",
                  }}
                />
                {stale ? "stale" : "healthy"}
              </span>
            )}
            <button
              type="button"
              onClick={() => onToggle(row.source, off)}
              aria-label={`${off ? "Enable" : "Disable"} ${row.source}`}
              aria-pressed={!off}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                padding: "0 2px",
                display: "flex",
                alignItems: "center",
                justifyContent: off ? "flex-start" : "flex-end",
                background: off ? "var(--raised)" : "#2a3f36",
                border: `1px solid ${off ? "var(--edge)" : "#3d6353"}`,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: off ? "var(--faint)" : "var(--ok)",
                }}
              />
            </button>
          </span>
        </div>

        {/*
          The distinction that matters, and the one Anansi can make honestly:
          an item either has a real saved-at from the extension watching it
          happen, or an import stamp. Labelled rather than left to colour.
        */}
        <Bar captured={row.captured} imported={row.imported} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
          <Fact k="captured live" v={row.captured.toLocaleString()} dim={row.captured === 0} />
          <Fact k="backfilled" v={row.imported.toLocaleString()} />
          <Fact k="media stored" v={`${row.mediaStored}/${row.media}`} />
          <Fact k="newest post" v={ago(row.lastPostedAt)} />
        </div>

        {row.captured === 0 && (
          <Note>
            Nothing captured live yet — every item here came from a backfill, so its saved date is
            the import time. New saves arrive with real ones once the extension is watching.
          </Note>
        )}

        {stale && !off && row.captured > 0 && (
          <Note tone="accent">
            Nothing new since {ago(row.lastSavedAt)}.{" "}
            {mode === "observe"
              ? "Press Import in the extension — it opens your favourites and scrolls them for you."
              : "Press Import in the extension to pick up anything missed."}
          </Note>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          marginTop: 14,
          borderTop: "1px solid var(--line)",
        }}
      >
        <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
          last capture {ago(row.lastSavedAt)}
        </span>
        {/*
          A real link, because the filters live in the URL. There is still no
          Import button here on purpose: importing is the extension's job, and
          a button in the web app that cannot do it would be decoration.
        */}
        {row.items > 0 && (
          <Link
            to="/"
            search={{ source: [row.source] }}
            style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--accent-text)" }}
          >
            View {row.items.toLocaleString()}
          </Link>
        )}
        <Mode mode={mode} push={row.items === 0} />
      </div>
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "accent" }) {
  return (
    <div
      className="mono"
      style={{
        marginTop: 12,
        padding: "9px 10px",
        borderRadius: 6,
        background: tone === "accent" ? "var(--accent-soft)" : "transparent",
        border: `1px solid ${tone === "accent" ? "#4a3c22" : "var(--line)"}`,
        fontSize: 10.5,
        color: tone === "accent" ? "var(--accent-text)" : "var(--faint)",
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Two facts in one bar, and neither is guessable from the other.
 *
 * The legend is not decoration: green and grey alone do not say which is
 * which, and the whole point of the bar is a distinction the reader has to be
 * able to name.
 */
function Bar({ captured, imported }: { captured: number; imported: number }) {
  const total = Math.max(captured + imported, 1);
  return (
    <div>
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#1a2027" }}>
        <div style={{ width: `${(captured / total) * 100}%`, background: "var(--ok)" }} />
        <div style={{ width: `${(imported / total) * 100}%`, background: "#39434c" }} />
      </div>
      <div className="mono" style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10, color: "var(--faint)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 2, background: "var(--ok)" }} />
          {captured.toLocaleString()} live
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 2, background: "#39434c" }} />
          {imported.toLocaleString()} backfilled
        </span>
      </div>
    </div>
  );
}

function Fact({ k, v, dim }: { k: string; v: string; dim?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span className="mono" style={{ fontSize: 14, color: dim ? "var(--faint)" : "var(--text)" }}>
        {v}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--faint)" }}>{k}</span>
    </div>
  );
}
