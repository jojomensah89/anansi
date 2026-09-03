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
 * Borrowed in shape only. [removed] lists seven platforms because breadth is its
 * pitch; the spec's non-goals rule that out, so this lists the two that exist
 * and says plainly what the others are. And it leads with capture health
 * rather than a connect button, because the failure this project most needs
 * to notice is an import that quietly returns nothing.
 */
const PLANNED = [
  { name: "Reddit", note: "saved posts and comments" },
  { name: "Instagram", note: "saved posts and reels" },
  { name: "TikTok", note: "favourites" },
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
  const [stats, setStats] = useState({ items: 0, authors: 0, x: 0, github: 0 });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.stats(controller.signal), api.sources(controller.signal)])
      .then(([s, r]) => {
        setStats({
          items: s.items,
          authors: s.authors,
          x: s.bySource.x ?? 0,
          github: s.bySource.github ?? 0,
        });
        setSources(r.sources);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
      <Rail total={stats.items} authors={stats.authors} bySource={{ x: stats.x, github: stats.github }} />

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
              return (
                <div
                  key={s.source}
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: 16,
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
                      {s.source === "github" ? "gh" : "x"}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {s.source === "github" ? "GitHub stars" : "X bookmarks"}
                      </span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                        {s.items.toLocaleString()} items · {s.authors} authors
                      </span>
                    </div>
                    <span
                      className="mono"
                      style={{
                        marginLeft: "auto",
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
            Not planned for v1
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {PLANNED.map((p) => (
              <div
                key={p.name}
                style={{
                  border: "1px dashed var(--line)",
                  borderRadius: 7,
                  padding: "12px 14px",
                }}
              >
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{p.name}</div>
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
            Each of these is a plausible afternoon that becomes a week. Two sources that answer
            questions well beat seven that half-work — the point of this library is what your
            agent can do with it, not how many logos it has.
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
