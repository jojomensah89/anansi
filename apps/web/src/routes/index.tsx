import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Card } from "../components/card.tsx";
import { Palette } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { FilterChips, useFilterBar, type Filters } from "../components/filters.tsx";
import { SelectBar } from "../components/selectbar.tsx";
import { RowView, TimelineView, ViewTabs, type ViewMode } from "../components/views.tsx";
import { useMasonry } from "../components/masonry.tsx";
import { LibraryActions } from "../components/library-actions.tsx";
import {
  CountBone,
  GridSkeleton,
  LoadMoreSkeleton,
  RowsSkeleton,
  useSlowLoad,
} from "../components/skeleton.tsx";
import { api, type Collection, type ItemRow, type SemanticSearchStatus } from "../lib/api.ts";
import { libraryKeys, useLibraryQuery } from "../lib/library-query.ts";
import { useHideRemoved } from "../lib/settings.ts";
import { toLibrarySearch, validateLibrarySearch } from "../lib/library-search.ts";

export const Route = createFileRoute("/")({
  component: Library,
  validateSearch: validateLibrarySearch,
});

function semanticNoticeFor(query: string | undefined, status: SemanticSearchStatus | undefined): { message: string; status: SemanticSearchStatus } | null {
  if (!query || !status?.enabled || (status.applied && status.state !== "warming") || status.degradedReason === "pagination-boundary") return null;
  const message = status.state === "warming"
    ? "Semantic index warming — showing available semantic results."
      : status.local && (status.state === "unavailable" || status.degradedReason === "provider-unavailable")
        ? "Ollama is unavailable — showing keyword results."
      : status.state === "error" || status.state === "paused" || status.degradedReason
        ? "Semantic search is unavailable — showing keyword results."
        : null;
  return message ? { message, status } : null;
}

function SemanticSearchNotice({ query, status }: { query: string | undefined; status: SemanticSearchStatus | undefined }) {
  const notice = semanticNoticeFor(query, status);
  if (!notice) return null;
  return (
    <div role="status" aria-live="polite" style={{ margin: "0 20px 10px", padding: "7px 10px", border: "1px solid var(--edge)", borderRadius: 5, color: "var(--faint)", fontSize: 11.5, background: "color-mix(in srgb, var(--card) 82%, transparent)" }}>
      {notice.message}
      {notice.status.pending !== undefined && notice.status.pending > 0 && (
        <span className="mono" style={{ marginLeft: 8, color: "var(--fainter)" }}>{notice.status.pending} pending</span>
      )}
    </div>
  );
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const view: ViewMode = search.view ?? "grid";
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const filters: Filters = useMemo(
    () => ({
      source: search.source,
      author: search.author,
      type: search.type,
      tag: search.tag,
      media: search.media,
      removed: search.removed as Filters["removed"],
      archived: search.archived,
      favorite: search.favorite,
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
    (next: Filters) => void navigate({ search: toLibrarySearch(next, view, { q: search.q, item: search.item }), replace: true }),
    [navigate, search.item, search.q, view],
  );

  const setView = useCallback(
    (next: ViewMode) => void navigate({ search: toLibrarySearch(filters, next, { q: search.q, item: search.item }), replace: true }),
    [navigate, filters, search.item, search.q],
  );

  /**
   * Two different waits, told apart.
   *
   * `firstLoad` is an empty screen with nothing to look at; paging is a screen
   * you are already reading. Only the first deserves a wall of shapes, and
   * neither deserves one for a load too fast to notice.
   */
  const [hideRemoved] = useHideRemoved();

  const ordering = view === "timeline" ? "posted" : "saved";
  const library = useLibraryQuery({ filters, query: search.q ?? "", order: ordering, hideRemoved });
  const items = library.items;
  const masonry = useMasonry(items);
  const stats = useQuery({ queryKey: libraryKeys.stats(), queryFn: ({ signal }) => api.stats(signal), retry: 1, staleTime: 15_000 });
  const total = stats.data?.items ?? 0;
  const authors = stats.data?.authors ?? 0;
  const visibleCount = search.archived ? (stats.data?.archived ?? 0) : total;
  const counts = stats.data?.bySource ?? {};

  const bar = useFilterBar({ filters, onChange: setFilters, bySource: counts });

  const firstLoad = useSlowLoad(library.isPending && items.length === 0);

  /**
   * A count has three states, not two: arrived, obviously late, and neither.
   * Drawing a placeholder in the third would put a grey box on screen for a
   * query that answers in twenty milliseconds.
   */
  const statsReady = stats.isSuccess;
  const statsSlow = useSlowLoad(stats.isPending);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && library.hasNextPage && !library.isFetchingNextPage) void library.fetchNextPage();
    });
    io.observe(node);
    return () => io.disconnect();
  }, [library.fetchNextPage, library.hasNextPage, library.isFetchingNextPage]);

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
    void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
  };

  const afterCardChange = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
		void queryClient.invalidateQueries({ queryKey: ["tags"] });
	}, [queryClient]);

  const openItem = useCallback((item: Pick<ItemRow, "id">, focusNote = false) => {
    setFocusNoteId(focusNote ? item.id : null);
    void navigate({ search: { ...search, item: item.id } });
  }, [navigate, search]);

  const applyCollection = useCallback((collection: Collection) => {
    const { query, cursor: _cursor, limit: _limit, order: _order, ...saved } = collection.filters;
    void navigate({ search: toLibrarySearch(saved, view, { q: query }) });
  }, [navigate, view]);
  const collectionFilters = useMemo<Collection["filters"]>(() => ({
    ...filters,
    removed: filters.removed ?? (hideRemoved ? "exclude" : "include"),
    order: ordering,
    query: search.q,
  }), [filters, hideRemoved, ordering, search.q]);

  return (
    <div className="anansi-shell" style={{ display: "flex", height: "100svh", overflow: "hidden" }}>
      <Rail total={total} authors={authors} archived={stats.data?.archived ?? 0} bySource={counts} ready={statsReady} />

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
              <span style={{ fontSize: 14, fontWeight: 600 }}>{search.q ? "Search results" : search.archived ? "Archived" : "Library"}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)", display: "flex", alignItems: "center", gap: 5 }}>
                {statsReady && `${visibleCount.toLocaleString()} saved items`}
                {!statsReady && statsSlow && (
                  <>
                    <CountBone digits={5} height={9} /> saved items
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
                    {search.q ? search.q : `Search ${visibleCount.toLocaleString()} saved items`}
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

                {search.q && (
                  <button type="button" onClick={() => void navigate({ search: toLibrarySearch(filters, view, { item: search.item }), replace: true })} style={{ height: 30, border: "none", background: "transparent", color: "var(--faint)", cursor: "pointer", font: "inherit", fontSize: 11.5 }}>
                    Clear search
                  </button>
                )}
                {stats.isError && <button type="button" onClick={() => void stats.refetch()} style={{ border: "none", background: "transparent", color: "#f2a7a7", cursor: "pointer", font: "inherit" }}>Counts unavailable · retry</button>}

                <LibraryActions current={collectionFilters} onApply={applyCollection} />

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

            <FilterChips bar={bar} matched={!library.hasNextPage && !library.isPending && !library.isError ? items.length : null} />
            <SemanticSearchNotice query={search.q} status={library.semantic} />
          </div>

          <div style={{ padding: "16px 20px" }}>
          {/*
            The first page and the next page are different waits. An empty
            screen needs a shape; a screen you are already reading needs a line
            at the bottom, not a wall of grey pushing your place away.
          */}
          {firstLoad && !library.isError && !search.q && view === "grid" && (
            <GridSkeleton columns={masonry.columns} containerRef={masonry.ref} />
          )}
          {firstLoad && !library.isError && (search.q || view === "row") && <RowsSkeleton />}
          {firstLoad && !library.isError && !search.q && view === "timeline" && <RowsSkeleton count={6} />}
          {library.isError && (
            <div role="alert" style={{ color: "var(--muted)", fontSize: 13, padding: 12 }}>
              {library.error instanceof Error ? library.error.message : "The library could not be loaded."}
              <button type="button" onClick={() => void library.refetch()} style={{ marginLeft: 10, border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text-dim)", padding: "5px 9px", cursor: "pointer" }}>Retry</button>
            </div>
          )}

          {!library.isPending && !library.isError && items.length === 0 && (
            <div style={{ padding: "40px 12px", color: "var(--muted)", fontSize: 13.5 }}>
              {search.q ? `No results for “${search.q}” in this view.` : bar.anyApplied ? "Nothing matches these filters." : "Your library is ready for its first save."}
              <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>
                {search.q || bar.anyApplied ? "Try a broader search or clear one filter above." : "Use the Anansi extension to save a page, star, post, or selection."}
              </div>
            </div>
          )}

          {!firstLoad && !search.q && view === "grid" && (
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
                      onOpen={openItem}
                      onToggle={toggle}
                      onChanged={afterCardChange}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {!firstLoad && (search.q || view === "row") && <RowView items={items} onOpen={openItem} />}
          {!firstLoad && !search.q && view === "timeline" && <TimelineView items={items} onOpen={openItem} />}
          <div ref={sentinel} style={{ height: 40 }} />
            {library.isFetchingNextPage && items.length > 0 && (
              <LoadMoreSkeleton />
            )}
            {library.isFetchNextPageError && (
              <div role="alert" style={{ display: "flex", alignItems: "center", gap: 9, color: "#f2a7a7", fontSize: 12, padding: 8 }}>
                More results could not be loaded.
                <button type="button" onClick={() => void library.fetchNextPage()} style={{ border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text-dim)", padding: "4px 8px", cursor: "pointer" }}>Retry</button>
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
        filters={filters}
        onOpen={(hit) => {
          setPaletteOpen(false);
          openItem(hit as ItemRow);
        }}
        onSearch={(query) => {
          setPaletteOpen(false);
          void navigate({ search: toLibrarySearch(filters, view, { q: query }), replace: true });
        }}
      />
      <Detail id={search.item ?? null} focusNote={focusNoteId === search.item} onClose={() => { setFocusNoteId(null); void navigate({ search: { ...search, item: undefined }, replace: true }); }} />
    </div>
  );
}
