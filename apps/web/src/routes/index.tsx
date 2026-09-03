import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Card } from "../components/card.tsx";
import { Palette } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { FilterBar, type Filters } from "../components/filters.tsx";
import { SelectBar } from "../components/selectbar.tsx";
import { MosaicView, RowView, TimelineView, ViewTabs, type ViewMode } from "../components/views.tsx";
import { useMasonry } from "../components/masonry.tsx";
import { api, type ItemRow } from "../lib/api.ts";

/**
 * The filters live in the URL.
 *
 * Not for the address bar's sake: it is what lets anything else in the app
 * point at a view of the library. "View 1,274" on Sources and a source in the
 * rail are ordinary links, not buttons that reach into this component's state,
 * and a filtered library survives a reload and can be sent to someone.
 *
 * Values are comma-joined rather than JSON-encoded, because ?source=x,tiktok
 * is a URL a person can read and edit and %5B%22x%22%5D is not.
 */
const VIEWS = ["grid", "row", "timeline", "mosaic"] as const;
const MEDIA_VALUES = ["any", "image", "video", "none"];

export interface LibrarySearch {
  source?: string[];
  author?: string[];
  type?: string[];
  tag?: string[];
  media?: string;
  archived?: boolean;
  view?: ViewMode;
}

/**
 * Anything can be typed into a URL, so nothing here trusts its input: an
 * unknown view or media value is dropped rather than passed to the query.
 */
function asList(value: unknown): string[] | undefined {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const list = [
    ...new Set(
      parts
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.length <= 120),
    ),
  ];
  return list.length > 0 ? list : undefined;
}

const some = (value: string[] | undefined) =>
  value && value.length > 0 ? value : undefined;

export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const media = typeof search.media === "string" ? search.media : undefined;
  const view = VIEWS.find((v) => v === search.view);
  return {
    source: asList(search.source),
    author: asList(search.author),
    type: asList(search.type),
    tag: asList(search.tag),
    media: media && MEDIA_VALUES.includes(media) ? media : undefined,
    archived: search.archived === true || search.archived === "true" ? true : undefined,
    view,
  };
}

export const Route = createFileRoute("/")({
  component: Library,
  validateSearch: validateLibrarySearch,
});

/** Absent rather than empty, so a cleared filter leaves no trace in the URL. */
function toSearch(filters: Filters, view: ViewMode): LibrarySearch {
  return {
    source: some(filters.source),
    author: some(filters.author),
    type: some(filters.type),
    tag: some(filters.tag),
    media: filters.media,
    archived: filters.archived ? true : undefined,
    // The default view is the absence of the param, so a plain "/" stays plain.
    view: view === "grid" ? undefined : view,
  };
}

/**
 * The Library.
 *
 * Search is an overlay and detail is a drawer, because both are things you do
 * *to* the library rather than places you go instead of it.
 *
 * Pagination is keyset and infinite. Offset paging would silently drop or
 * repeat items whenever an import ran underneath a scroll, which is a thing
 * that will happen.
 */
function Library() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [authors, setAuthors] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const view: ViewMode = search.view ?? "grid";
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const sentinel = useRef<HTMLDivElement>(null);
  const masonry = useMasonry(items);

  const filters: Filters = useMemo(
    () => ({
      source: search.source,
      author: search.author,
      type: search.type,
      tag: search.tag,
      media: search.media,
      archived: search.archived,
    }),
    [search],
  );

  /**
   * Replace rather than push.
   *
   * Every toggle in a multi-select would otherwise be its own history entry,
   * and backing out of a three-author filter one author at a time is not what
   * the back button is for.
   */
  const setFilters = useCallback(
    (next: Filters) => void navigate({ search: toSearch(next, view), replace: true }),
    [navigate, view],
  );

  const setView = useCallback(
    (next: ViewMode) => void navigate({ search: toSearch(filters, next), replace: true }),
    [navigate, filters],
  );

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then((s) => {
        setTotal(s.items);
        setAuthors(s.authors);
        setCounts(s.bySource);
      })
      .catch(() => {});
  }, []);

  useEffect(() => refreshStats(), [refreshStats]);

  // A filter change is a different query, not more of the same one — and so
  // is switching to or from Timeline, which changes the sort order.
  const ordering = view === "timeline" ? "posted" : "saved";
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDone(false);
  }, [filters, ordering]);

  const loadMore = useCallback(async () => {
    if (done) return;
    setLoading(true);
    try {
      const page = await api.items({
        ...filters,
        cursor,
        // Timeline needs the whole library in date order, not the loaded page
        // re-sorted — otherwise its groups are only true of what you happen
        // to have scrolled past.
        order: view === "timeline" ? "posted" : "saved",
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
  }, [cursor, done, filters, view]);

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
      if (e.key === "Escape" && selecting) {
        setSelecting(false);
        setPicked(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const toggle = (item: ItemRow) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  /** A bulk action changes the set under you, so reload rather than patch. */
  const afterBulk = () => {
    setPicked(new Set());
    setSelecting(false);
    setItems([]);
    setCursor(null);
    setDone(false);
    refreshStats();
  };

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

          <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
          <ViewTabs value={view} onChange={setView} />

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              style={{
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

            <button
              type="button"
              onClick={() => {
                setSelecting((s) => !s);
                setPicked(new Set());
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                height: 30,
                padding: "0 11px",
                borderRadius: 5,
                cursor: "pointer",
                font: "inherit",
                fontSize: 12.5,
                background: selecting ? "var(--accent)" : "var(--card)",
                color: selecting ? "var(--ink)" : "var(--text-dim)",
                border: `1px solid ${selecting ? "var(--accent)" : "var(--edge)"}`,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12l5 5L20 6" />
              </svg>
              Select
            </button>
          </div>
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          bySource={counts}
          matched={done ? items.length : null}
        />

        <div className="scroll" style={{ flex: 1, padding: "16px 20px" }}>
          {error && (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: 12 }}>
              {error}
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 6 }}>
                Is the API running? bun run apps/web/scripts/serve-local.ts
              </div>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div style={{ padding: "40px 12px", color: "var(--muted)", fontSize: 13.5 }}>
              Nothing matches these filters.
              <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>
                Clear one from the bar above.
              </div>
            </div>
          )}

          {view === "grid" && (
            /*
              Columns packed shortest-first rather than a CSS grid. Grid rows
              are as tall as their tallest member, so a 137px card beside a
              535px one leaves 400px of hole.
            */
            <div ref={masonry.ref} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              {masonry.buckets.map((bucket, column) => (
                <div key={column} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                  {bucket.map((item) => (
                    <Card
                      key={item.id}
                      item={item}
                      selectable={selecting}
                      selected={picked.has(item.id)}
                      onOpen={(i) => setOpenId(i.id)}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {view === "row" && <RowView items={items} onOpen={(i) => setOpenId(i.id)} />}
          {view === "timeline" && <TimelineView items={items} onOpen={(i) => setOpenId(i.id)} />}
          {view === "mosaic" && <MosaicView items={items} onOpen={(i) => setOpenId(i.id)} />}
          <div ref={sentinel} style={{ height: 40 }} />
          {loading && (
            <div className="mono" style={{ fontSize: 11, color: "var(--faint)", padding: 8 }}>
              loading…
            </div>
          )}
        </div>
      </div>

      {selecting && picked.size > 0 && (
        <SelectBar
          ids={[...picked]}
          onClear={() => setPicked(new Set())}
          onSelectAll={() => setPicked(new Set(items.map((i) => i.id)))}
          loaded={items.length}
          archived={!!filters.archived}
          onDone={afterBulk}
        />
      )}

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
