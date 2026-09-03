import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { api, type SourceRow } from "../lib/api.ts";

export const Route = createFileRoute("/sources")({ component: Sources });

/**
 * Where each source stands.
 *
 * Borrowed in shape from [removed]'s Connections page, which gets one thing very
 * right: a library is an ongoing process, not a pile, and the question you
 * actually have is "is this still working?" — which no grid of cards answers.
 *
 * It leads with capture health rather than a connect button, because the
 * failure this project most needs to notice is an import that quietly returns
 * nothing.
 *
 * Sources with nothing in them yet are still listed, with their capture mode
 * stated. "Observe" is not a lesser version of "page" — it is the only thing
 * possible for a platform that publishes no history endpoint, and saying so
 * is better than letting an empty card read as broken.
 */
const PLANNED: { name: string; source: string; mode: "page" | "observe"; note: string }[] = [
  { name: "Reddit", source: "reddit", mode: "page", note: "saved posts and comments" },
  { name: "TikTok", source: "tiktok", mode: "observe", note: "favourites" },
];

function ago(unix: number | null): string {
  if (!unix) return "never";
  const mins = Math.round((Date.now() - unix * 1000) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Sources() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const toggle = (source: string, enabled: boolean) => {
    // Optimistic: the switch is the whole interaction, and waiting a round
    // trip to move it makes it feel broken.
    setSources((prev) => prev.map((s) => (s.source === source ? { ...s, enabled } : s)));
    api.toggleSource(source, enabled).catch(() => {
      setSources((prev) => prev.map((s) => (s.source === source ? { ...s, enabled: !enabled } : s)));
    });
  };

  const [stats, setStats] = useState<{ items: number; authors: number; bySource: Record<string, number> }>({ items: 0, authors: 0, bySource: {} });

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
        </div>

        <div className="scroll" style={{ flex: 1, padding: "20px 22px 60px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: 14,
            }}
          >
            {sources.map((s) => {
              const stale = s.lastSavedAt !== null && Date.now() / 1000 - s.lastSavedAt > 7 * 86400;
              const off = s.enabled === false;
              return (
                <div
                  key={s.source}
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: 16,
                    // Dimmed, never hidden: an absent source reads as broken.
                    opacity: off ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span
                      className="mono"
                      style={{
                        width: 30,
                        height: 30,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 7,
                        border: "1px solid var(--edge-strong)",
                        fontSize: 12,
                        color: "var(--text-dim)",
                      }}
                    >
                      {({ github: "gh", reddit: "r/", tiktok: "tt" } as Record<string, string>)[s.source] ?? "x"}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {({
                          github: "GitHub stars",
                          reddit: "Reddit saves",
                          tiktok: "TikTok favourites",
                        } as Record<string, string>)[s.source] ?? "X bookmarks"}
                      </span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                        {s.items.toLocaleString()} items · {s.authors} authors
                      </span>
                    </div>
                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                      {!off && (
                        <span className="mono" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: stale ? "var(--accent)" : "var(--ok)" }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: stale ? "var(--accent)" : "var(--ok)" }} />
                          {stale ? "stale" : "healthy"}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => toggle(s.source, off)}
                        aria-label={`${off ? "Enable" : "Disable"} ${s.source}`}
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
                        <span style={{ width: 14, height: 14, borderRadius: "50%", background: off ? "var(--faint)" : "var(--ok)" }} />
                      </button>
                    </span>
                  </div>

                  {/*
                    The distinction that matters, and the one Anansi can make
                    honestly: an item either has a real saved-at from the
                    extension watching it happen, or an import stamp.
                  */}
                  <Bar captured={s.captured} imported={s.imported} />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
                    <Fact k="captured live" v={s.captured.toLocaleString()} dim={s.captured === 0} />
                    <Fact k="backfilled" v={s.imported.toLocaleString()} />
                    <Fact k="media stored" v={`${s.mediaStored}/${s.media}`} />
                    <Fact k="newest post" v={ago(s.lastPostedAt)} />
                  </div>

                  {s.captured === 0 && (
                    <div
                      className="mono"
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: "1px solid var(--line)",
                        fontSize: 10.5,
                        color: "var(--faint)",
                        lineHeight: 1.55,
                      }}
                    >
                      Nothing captured live yet — every item here came from a backfill, so its
                      saved date is the import time. Install the extension and new saves arrive
                      with real ones.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="mono"
            style={{
              marginTop: 28,
              marginBottom: 12,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--fainter)",
            }}
          >
            Connected, nothing captured yet
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {PLANNED.filter((p) => !sources.some((s) => s.source === p.source)).map((p) => (
              <div
                key={p.name}
                style={{
                  border: "1px dashed var(--line)",
                  borderRadius: 7,
                  padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{p.name}</span>
                  <span
                    className="mono"
                    style={{
                      marginLeft: "auto",
                      fontSize: 9.5,
                      padding: "1px 5px",
                      borderRadius: 3,
                      border: "1px solid var(--edge)",
                      color: p.mode === "observe" ? "var(--accent)" : "var(--faint)",
                    }}
                  >
                    {p.mode}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--fainter)", marginTop: 3 }}>
                  {p.note}
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--faint)",
              lineHeight: 1.6,
              maxWidth: 620,
            }}
          >
            <strong style={{ color: "var(--muted)", fontWeight: 500 }}>page</strong> means the
            extension can walk your whole history itself.{" "}
            <strong style={{ color: "var(--accent)", fontWeight: 500 }}>observe</strong> means the
            platform publishes no history endpoint and signs its own requests, so capture happens
            by watching what the app fetches while you scroll. TikTok is the second kind: there is
            no import button for it, and your history arrives the first time you scroll your
            favourites.
          </div>
        </div>
      </div>
    </div>
  );
}

function Bar({ captured, imported }: { captured: number; imported: number }) {
  const total = Math.max(captured + imported, 1);
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#1a2027" }}>
      <div style={{ width: `${(captured / total) * 100}%`, background: "var(--ok)" }} />
      <div style={{ width: `${(imported / total) * 100}%`, background: "var(--accent)" }} />
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
