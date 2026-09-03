import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Detail } from "../components/detail.tsx";
import { FieldFilter } from "../components/filters.tsx";
import { SourceMark } from "../components/sourcemark.tsx";
import { api, type Creator, type ItemRow } from "../lib/api.ts";

/** The same order and labels the Library bar offers. */
const PLATFORMS = [
  { value: "x", label: "X" },
  { value: "github", label: "GitHub" },
  { value: "reddit", label: "Reddit" },
  { value: "tiktok", label: "TikTok" },
];

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
  const [stats, setStats] = useState<{ items: number; authors: number; bySource: Record<string, number> }>({ items: 0, authors: 0, bySource: {} });
  const [filter, setFilter] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [posts, setPosts] = useState<ItemRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.stats(controller.signal), api.creators(1000, controller.signal)])
      .then(([s, c]) => {
        setStats({ items: s.items, authors: s.authors, bySource: s.bySource });
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
      .items({ author: [selected], limit: 50 }, controller.signal)
      .then((p) => setPosts(p.items))
      .catch(() => {});
    return () => controller.abort();
  }, [selected]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return creators.filter((c) => {
      // Values within the field are ORed, exactly as the chip says.
      if (platforms.length > 0 && !platforms.includes(c.source)) return false;
      if (!q) return true;
      return (
        (c.authorHandle ?? "").toLowerCase().includes(q) ||
        (c.authorName ?? "").toLowerCase().includes(q)
      );
    });
  }, [creators, filter, platforms]);

  /**
   * The share bar is a share of what is shown.
   *
   * Filtering to one platform and leaving the bars scaled to the unfiltered
   * leader would draw every remaining creator as a stub, which reads as "these
   * people barely matter" rather than "you filtered".
   */
  const top = shown[0]?.saves ?? 1;

  const once = creators.filter((c) => c.saves === 1).length;
  const topTenShare = stats.items
    ? Math.round((creators.slice(0, 10).reduce((n, c) => n + c.saves, 0) / stats.items) * 100)
    : 0;
  const perAuthor = stats.authors ? (stats.items / stats.authors).toFixed(2) : "0";

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
          <span style={{ fontSize: 14, fontWeight: 600 }}>Creators</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            {stats.authors} authors · {stats.items.toLocaleString()} saves
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <FieldFilter
              label="Platform"
              values={platforms}
              onChange={setPlatforms}
              options={PLATFORMS.filter((p) => (stats.bySource[p.value] ?? 0) > 0).map((p) => ({
                ...p,
                count: creators.filter((c) => c.source === p.value).length,
                icon: <SourceMark source={p.value} size={13} />,
              }))}
            />
            {(platforms.length > 0 || filter.trim() !== "") && (
              <span className="mono" style={{ fontSize: 10.5, color: "var(--faintest)" }}>
                {shown.length.toLocaleString()} of {creators.length.toLocaleString()}
              </span>
            )}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter creators"
            style={{
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
                  {c.authorAvatar ? (
                    <img
                      src={c.authorAvatar}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      style={{ borderRadius: "50%", flexShrink: 0, background: "var(--edge-strong)" }}
                    />
                  ) : (
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--edge-strong)", flexShrink: 0 }} />
                  )}
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    {c.authorName && (
                      <span style={{ fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.authorName}
                      </span>
                    )}
                    <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                      @{c.authorHandle}
                    </span>
                  </span>
                  {/* Which platform this handle is on: two people can share a
                      name across sites, and the count alone hides that. */}
                  <span style={{ display: "flex", color: "var(--fainter)", flexShrink: 0 }}>
                    <SourceMark source={c.source} size={12} />
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
