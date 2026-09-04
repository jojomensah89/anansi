import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Card } from "../components/card.tsx";
import { Palette } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { FilterChips, FilterTrigger, useFilterBar, type Filters } from "../components/filters.tsx";
import { SelectBar } from "../components/selectbar.tsx";
import { MosaicView, RowView, TimelineView, ViewTabs, type ViewMode } from "../components/views.tsx";
import { useMasonry } from "../components/masonry.tsx";
import {
  CountBone,
  GridSkeleton,
  MosaicSkeleton,
  RowsSkeleton,
  useSlowLoad,
} from "../components/skeleton.tsx";
import { api, type ItemRow } from "../lib/api.ts";
import { useHideRemoved } from "../lib/settings.ts";
import { toLibrarySearch, validateLibrarySearch } from "../lib/library-search.ts";

export const Route = createFileRoute("/")({
  component: Library,
  validateSearch: validateLibrarySearch,
});


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
      removed: search.removed as Filters["removed"],
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
    (next: Filters) => void navigate({ search: toLibrarySearch(next, view), replace: true }),
    [navigate, view],
  );

  const setView = useCallback(
    (next: ViewMode) => void navigate({ search: toLibrarySearch(filters, next), replace: true }),
    [navigate, filters],
  );

  /**
   * Two different waits, told apart.
   *
   * `firstLoad` is an empty screen with nothing to look at; paging is a screen
   * you are already reading. Only the first deserves a wall of shapes, and
   * neither deserves one for a load too fast to notice.
   */
  const [hideRemoved] = useHideRemoved();

  const bar = useFilterBar({ filters, onChange: setFilters, bySource: counts });

  const firstLoad = useSlowLoad(loading && items.length === 0);

  /**
   * A count has three states, not two: arrived, obviously late, and neither.
   * Drawing a placeholder in the third would put a grey box on screen for a
   * query that answers in twenty milliseconds.
   */
  const statsReady = total > 0;
  const statsSlow = useSlowLoad(!statsReady);

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
  }, [filters, ordering, hideRemoved]);

  const loadMore = useCallback(async () => {
    if (done) return;
    setLoading(true);
    try {
      const page = await api.items({
        ...filters,
        /*
          The chip wins over the preference. Asking to see what has been
          removed while the setting hides removed items would otherwise return
          nothing — and an empty grid is indistinguishable from a broken one.
        */
        removed: filters.removed ?? (hideRemoved ? "exclude" : "include"),
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
  }, [cursor, done, filters, view, hideRemoved]);

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
        <div className="scroll" style={{ flex: 1 }}>
          {/*
            Glass, and therefore sticky inside the scroller rather than fixed
            above it. Blur over an empty background is just a tint; the header
            has to have the library passing beneath it for the effect to be
            anything at all.
          */}
          <div className="glass" style={{ position: "sticky", top: 0, zIndex: 30 }}>
            <div
              style={{
                height: 46,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 20px",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600 }}>Library</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)", display: "flex", alignItems: "center", gap: 5 }}>
                {statsReady && `${total.toLocaleString()} items · ${authors} authors`}
                {!statsReady && statsSlow && (
                  <>
                    <CountBone digits={5} height={9} /> items · <CountBone digits={4} height={9} /> authors
                  </>
                )}
              </span>
            </div>

            {/*
              One level: the views you can be in, and everything you can do to
              them. Search and Add filter were on separate rows, which made
              choosing a view feel like a different kind of act from narrowing
              one.
            */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 20px 10px",
                flexWrap: "wrap",
              }}
            >
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
                    width: 232,
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

                <FilterTrigger bar={bar} />

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

            <FilterChips bar={bar} matched={done ? items.length : null} />
          </div>

          <div style={{ padding: "16px 20px" }}>
          {/*
            The first page and the next page are different waits. An empty
            screen needs a shape; a screen you are already reading needs a line
            at the bottom, not a wall of grey pushing your place away.
          */}
          {firstLoad && !error && view === "grid" && (
            <GridSkeleton columns={masonry.columns} containerRef={masonry.ref} />
          )}
          {firstLoad && !error && view === "row" && <RowsSkeleton />}
          {firstLoad && !error && view === "timeline" && <RowsSkeleton count={6} />}
          {firstLoad && !error && view === "mosaic" && <MosaicSkeleton />}
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

          {!firstLoad && view === "grid" && (
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

          {!firstLoad && view === "row" && <RowView items={items} onOpen={(i) => setOpenId(i.id)} />}
          {!firstLoad && view === "timeline" && <TimelineView items={items} onOpen={(i) => setOpenId(i.id)} />}
          {!firstLoad && view === "mosaic" && <MosaicView items={items} onOpen={(i) => setOpenId(i.id)} />}
          <div ref={sentinel} style={{ height: 40 }} />
            {loading && items.length > 0 && (
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)", padding: 8 }} aria-live="polite">
                loading more…
              </div>
            )}
          </div>
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
