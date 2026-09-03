import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Card } from "../components/card.tsx";
import { Palette } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { api, type ItemRow } from "../lib/api.ts";

export const Route = createFileRoute("/")({ component: Library });

type Filter = "all" | "x" | "github";

/**
 * The Library.
 *
 * Two views, not four — this and Creators. Search is an overlay and detail is
 * a drawer, because both are things you do *to* the library rather than
 * places you go instead of it.
 *
 * Pagination is keyset and infinite: the grid appends as you reach the end.
 * Offset paging would silently drop or repeat items whenever an import runs
 * underneath a scroll, which is a thing that will happen.
 */
function Library() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ x: 0, github: 0 });
  const [authors, setAuthors] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // One request for everything the shell needs, so the rail and the grid can
  // never disagree about how many things there are.
  useEffect(() => {
    const controller = new AbortController();
    api
      .stats(controller.signal)
      .then((s) => {
        setTotal(s.items);
        setAuthors(s.authors);
        setCounts({ x: s.bySource.x ?? 0, github: s.bySource.github ?? 0 });
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const reset = useCallback(() => {
    setItems([]);
    setCursor(null);
    setDone(false);
  }, []);

  useEffect(reset, [filter, reset]);

  const loadMore = useCallback(async () => {
    if (done) return;
    setLoading(true);
    try {
      const page = await api.items({
        cursor,
        source: filter === "all" ? undefined : filter,
        limit: 60,
      });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      if (page.nextCursor === null) setDone(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setDone(true);
    } finally {
      setLoading(false);
    }
  }, [cursor, done, filter]);

  useEffect(() => {
    if (items.length === 0 && !done) void loadMore();
  }, [items.length, done, loadMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && !done) void loadMore();
    });
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore, loading, done]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
      <Rail total={total} authors={authors} bySource={counts} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            height: 52,
            flexShrink: 0,
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 20px",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Library</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            {total.toLocaleString()} items · {authors} authors
          </span>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 30,
              padding: "0 10px 0 9px",
              border: "1px solid var(--edge)",
              borderRadius: 5,
              background: "var(--card)",
              width: 250,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fainter)" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-4.2-4.2" />
            </svg>
            <span style={{ fontSize: 12.5, color: "var(--fainter)" }}>
              Search {total.toLocaleString()} saves
            </span>
            <span
              className="mono"
              style={{
                marginLeft: "auto",
                fontSize: 10,
                color: "var(--faintest)",
                border: "1px solid var(--edge)",
                borderRadius: 3,
                padding: "1px 4px",
              }}
            >
              ⌘K
            </span>
          </button>
        </div>

        <div
          style={{
            height: 42,
            flexShrink: 0,
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "0 20px",
          }}
        >
          {(["all", "x", "github"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="mono"
              style={{
                fontSize: 11,
                padding: "4px 9px",
                borderRadius: 4,
                cursor: "pointer",
                font: "inherit",
                fontFamily: "var(--mono)",
                background: filter === f ? "#1e2329" : "transparent",
                color: filter === f ? "var(--text)" : "var(--muted)",
                border: `1px solid ${filter === f ? "#2e373f" : "var(--line)"}`,
              }}
            >
              {f}
            </button>
          ))}
          <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--fainter)" }}>
            {items.length} loaded{done ? " · end" : ""}
          </span>
        </div>

        <div className="scroll" style={{ flex: 1, padding: "16px 20px" }}>
          {error && (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: 12 }}>
              {error}
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 6 }}>
                Is the API running? bun run apps/web/scripts/serve-local.ts
              </div>
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 14,
              alignContent: "start",
            }}
          >
            {items.map((item) => (
              <Card key={item.id} item={item} onOpen={(i) => setOpenId(i.id)} />
            ))}
          </div>
          <div ref={sentinel} style={{ height: 40 }} />
          {loading && (
            <div className="mono" style={{ fontSize: 11, color: "var(--faint)", padding: 8 }}>
              loading…
            </div>
          )}
        </div>
      </div>

      <Palette
        open={paletteOpen}
        total={total}
        onClose={() => setPaletteOpen(false)}
        onOpen={(hit) => {
          setPaletteOpen(false);
          setOpenId(hit.id);
        }}
      />
      <Detail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
