import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Detail } from "../components/detail.tsx";
import { api, type Creator, type ItemRow } from "../lib/api.ts";

export const Route = createFileRoute("/creators")({ component: Creators });

/**
 * Creators.
 *
 * The canvas note is the whole design: "Creators is a group-by, not a table to
 * build. The honest headline is the long tail." So the summary strip leads
 * with how many authors appear exactly once, rather than burying it under a
 * top-ten leaderboard that flatters the library.
 */
function Creators() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [stats, setStats] = useState({ items: 0, authors: 0, x: 0, github: 0 });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [posts, setPosts] = useState<ItemRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.stats(controller.signal), api.creators(1000, controller.signal)])
      .then(([s, c]) => {
        setStats({
          items: s.items,
          authors: s.authors,
          x: s.bySource.x ?? 0,
          github: s.bySource.github ?? 0,
        });
        setCreators(c.creators);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected) {
      setPosts([]);
      return;
    }
    const controller = new AbortController();
    api
      .items({ author: selected, limit: 50 }, controller.signal)
      .then((p) => setPosts(p.items))
      .catch(() => {});
    return () => controller.abort();
  }, [selected]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? creators.filter((c) => (c.authorHandle ?? "").toLowerCase().includes(q)) : creators;
  }, [creators, filter]);

  const once = creators.filter((c) => c.saves === 1).length;
  const top = creators[0]?.saves ?? 1;
  const topTenShare = stats.items
    ? Math.round((creators.slice(0, 10).reduce((n, c) => n + c.saves, 0) / stats.items) * 100)
    : 0;
  const perAuthor = stats.authors ? (stats.items / stats.authors).toFixed(2) : "0";

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
          <span style={{ fontSize: 14, fontWeight: 600 }}>Creators</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            {stats.authors} authors · {stats.items.toLocaleString()} saves
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter creators"
            style={{
              marginLeft: "auto",
              height: 30,
              width: 210,
              padding: "0 10px",
              border: "1px solid var(--edge)",
              borderRadius: 5,
              background: "var(--card)",
              color: "var(--text)",
              fontSize: 12.5,
              fontFamily: "var(--sans)",
              outline: "none",
            }}
          />
        </div>

        <div
          style={{
            flexShrink: 0,
            borderBottom: "1px solid var(--line)",
            padding: "16px 22px",
            display: "flex",
            gap: 44,
          }}
        >
          <Stat n={String(stats.authors)} label="authors" />
          <Stat n={perAuthor} label="saves per author" />
          <Stat n={`${topTenShare}%`} label="of saves from top 10" accent />
          <Stat n={String(once)} label="saved exactly once" />
        </div>

        <div className="scroll" style={{ flex: 1, padding: "0 22px" }}>
          <div
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: "34px 1fr 320px 92px",
              gap: 16,
              alignItems: "center",
              padding: "11px 8px",
              borderBottom: "1px solid var(--line)",
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--fainter)",
              position: "sticky",
              top: 0,
              background: "var(--ink)",
            }}
          >
            <span>#</span>
            <span>Creator</span>
            <span>Share of library</span>
            <span style={{ textAlign: "right" }}>Saves</span>
          </div>

          {shown.map((c, i) => {
            const active = selected === c.authorHandle;
            return (
              <button
                key={c.authorHandle ?? i}
                type="button"
                onClick={() => setSelected(active ? null : c.authorHandle)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "34px 1fr 320px 92px",
                  gap: 16,
                  alignItems: "center",
                  padding: "11px 8px",
                  width: "100%",
                  textAlign: "left",
                  font: "inherit",
                  color: "inherit",
                  cursor: "pointer",
                  background: active ? "var(--card)" : "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--line-soft)",
                }}
              >
                <span className="mono" style={{ fontSize: 11.5, color: i === 0 ? "var(--accent)" : "var(--faint)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--edge-strong)", flexShrink: 0 }} />
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    @{c.authorHandle}
                  </span>
                </span>
                <span style={{ height: 6, borderRadius: 3, background: "#1a2027", display: "block", position: "relative" }}>
                  <span
                    style={{
                      position: "absolute",
                      inset: "0 auto 0 0",
                      width: `${Math.max((c.saves / top) * 100, 2)}%`,
                      borderRadius: 3,
                      background: i === 0 ? "var(--accent)" : "#4a5761",
                    }}
                  />
                </span>
                <span className="mono" style={{ fontSize: 13, textAlign: "right" }}>{c.saves}</span>
              </button>
            );
          })}

          {selected && posts.length > 0 && (
            <div style={{ padding: "18px 8px 40px" }}>
              <div
                className="mono"
                style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--fainter)", marginBottom: 10 }}
              >
                {posts.length} saved from @{selected}
              </div>
              {posts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setOpenId(p.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: "var(--muted)",
                    padding: "9px 11px",
                    marginBottom: 6,
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 5,
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  {p.excerpt.slice(0, 160)}
                </button>
              ))}
            </div>
          )}

          <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 8px 40px", fontSize: 11, color: "var(--fainter)" }}>
            {once} of {stats.authors} saved exactly once
            <span style={{ flex: 1, height: 1, background: "var(--line-soft)" }} />
          </div>
        </div>
      </div>

      <Detail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function Stat({ n, label, accent }: { n: string; label: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="mono" style={{ fontSize: 20, color: accent ? "var(--accent)" : "var(--text)" }}>
        {n}
      </span>
      <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{label}</span>
    </div>
  );
}
