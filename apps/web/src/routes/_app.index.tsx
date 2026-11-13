import { Button } from "@anansi/ui/components/button";
import { PhoneActions } from "../components/phone-actions.tsx";
import { Search, SlidersHorizontal, SquareCheck, X } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "../components/rail.tsx";
import { Card } from "../components/card.tsx";
import { modKey as paletteModKey, Palette } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { FilterChips, FilterTrigger, useFilterBar, type Filters } from "../components/filters.tsx";
import { SelectBar } from "../components/selectbar.tsx";
import { RowView, TimelineView, ViewTabs, type ViewMode } from "../components/views.tsx";
import { useMasonry } from "../components/masonry.tsx";
import { SaveAsShelf } from "../components/library-actions.tsx";
import { ShelfViewContext } from "../components/shelf-picker.tsx";
import { useIsTopic } from "../components/tag-chip.tsx";
import {
  GridSkeleton,
  LoadMoreSkeleton,
  RowsSkeleton,
  useSlowLoad,
} from "../components/skeleton.tsx";
import { api, type ItemRow, type SemanticSearchStatus } from "../lib/api.ts";
import { useShelves } from "../lib/shelf-queries.ts";
import { describeRule, hasRule, openShelfDialog, ruleFromFilters } from "../lib/shelves.ts";
import { expectIncomingSaves, libraryFreshnessOptions, libraryKeys, libraryStatsChanged, libraryStatsFingerprint, useLibraryQuery } from "../lib/library-query.ts";
import { useHideRemoved, useShowNsfw } from "../lib/settings.ts";
import { toLibrarySearch, validateLibrarySearch } from "../lib/library-search.ts";

export const Route = createFileRoute("/")({
  component: Library,
  validateSearch: validateLibrarySearch,
});

function semanticNoticeFor(query: string | undefined, status: SemanticSearchStatus | undefined): { message: string; status: SemanticSearchStatus } | null {
  if (!query || !status?.enabled || (status.applied && status.state !== "warming")) return null;
  const message = status.state === "warming"
    ? "Semantic index warming — showing available semantic results."
      : status.degradedReason === "pagination-boundary"
        ? "Continuing with keyword-ranked results after semantic matches."
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
    <div role="status" aria-live="polite" style={{ margin: "0 20px 10px", padding: "7px 10px", border: "1px solid var(--edge)", borderRadius: 5, color: "var(--faint)", fontSize: "var(--text-body)", background: "color-mix(in srgb, var(--card) 82%, transparent)" }}>
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
  // ⌘ on Apple keyboards, Ctrl elsewhere; decided after hydration.
  const [modKey, setModKey] = useState("⌘");
  useEffect(() => setModKey(paletteModKey() === "⌘" ? "⌘" : "Ctrl "), []);
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
      nsfw: search.nsfw,
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
    (next: Filters) => void navigate({ search: toLibrarySearch(next, view, { q: search.q, item: search.item, shelf: search.shelf }), replace: true }),
    [navigate, search.item, search.q, search.shelf, view],
  );

  const setView = useCallback(
    (next: ViewMode) => void navigate({ search: toLibrarySearch(filters, next, { q: search.q, item: search.item, shelf: search.shelf }), replace: true }),
    [navigate, filters, search.item, search.q, search.shelf],
  );

  /**
   * Two different waits, told apart.
   *
   * `firstLoad` is an empty screen with nothing to look at; paging is a screen
   * you are already reading. Only the first deserves a wall of shapes, and
   * neither deserves one for a load too fast to notice.
   */
  const [hideRemoved] = useHideRemoved();
  const [showNsfw] = useShowNsfw();

  const ordering = view === "timeline" ? "posted" : "saved";
  // A shelf narrows the library like any filter, but it is not one of the bar's chips.
  const queryFilters = useMemo(() => (search.shelf ? { ...filters, shelf: search.shelf } : filters), [filters, search.shelf]);
  const library = useLibraryQuery({ filters: queryFilters, query: search.q ?? "", order: ordering, hideRemoved, showNsfw });
  const shelves = useShelves();
  const viewing = search.shelf ? (shelves.data?.find((shelf) => shelf.id === search.shelf) ?? null) : null;
  const isTopic = useIsTopic();
  const items = library.items;
  const masonry = useMasonry(items, 340);
  const stats = useQuery({ queryKey: libraryKeys.stats(), queryFn: ({ signal }) => api.stats(signal), retry: 1, staleTime: 15_000, ...libraryFreshnessOptions });
  const total = stats.data?.items ?? 0;
  const authors = stats.data?.authors ?? 0;
  const counts = stats.data?.bySource ?? {};

  useEffect(() => {
    // Sync help only: the library works the same if this request fails.
    expectIncomingSaves();
    void api.requestSync().catch(() => {});
  }, []);

  const previousStatsFingerprint = useRef<string | null>(null);
  useEffect(() => {
    if (!stats.data) return;
    const fingerprint = libraryStatsFingerprint(stats.data);
    const previous = previousStatsFingerprint.current;
    previousStatsFingerprint.current = fingerprint;
    if (libraryStatsChanged(previous, fingerprint)) {
      // Stats are the change probe (see libraryPollInterval). Refresh only the active
      // filter/search/order chain when the library's counts actually change.
      void queryClient.invalidateQueries({ queryKey: library.key, exact: true });
    }
  }, [library.key, queryClient, stats.data]);

  const bar = useFilterBar({ filters, onChange: setFilters, bySource: counts });

  const firstLoad = useSlowLoad(library.isPending && items.length === 0);

  /** The rail and the top bar draw their own late placeholder for counts. */
  const statsReady = stats.isSuccess;

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

  /** What "Save as shelf" offers as the rule: the filters and search on screen. */
  const currentRule = useMemo(() => ruleFromFilters({ ...filters, query: search.q }), [filters, search.q]);
  const goToShelf = useCallback((shelf: { id: string }) => void navigate({ search: { shelf: shelf.id } }), [navigate]);

  return (
    <ShelfViewContext.Provider value={viewing}>
    <div className={`anansi-shell capture-workspace${search.item ? " inspector-open" : ""}`}>
      <Rail total={total} authors={authors} archived={stats.data?.archived ?? 0} bySource={counts} ready={statsReady} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="scroll" style={{ flex: 1 }}>

          {/*
            One row of tools under the frame's top bar: the view you are in on
            the left, then everything you can do to it. Applied filters get
            their own row beneath, where they can wrap.
          */}
          <div className="library-toolbar-wrap">
            <div className="library-toolbar">
              <ViewTabs value={view} onChange={setView} />
              <div className="library-toolbar-end">
                <div className="library-search">
                  <Button
                    variant="outline"
                    type="button"
                    className="library-search-field"
                    onClick={() => setPaletteOpen(true)}
                    aria-label={search.q ? `Search: ${search.q}` : "Search"}
                    aria-keyshortcuts="Meta+K Control+K"
                    data-filled={search.q ? true : undefined}
                  >
                    <Search aria-hidden="true" size={16} strokeWidth={1.5} />
                    <span className="library-search-text">{search.q ? search.q : "Search"}</span>
                    <kbd className="keycap library-search-keys">{modKey}K</kbd>
                  </Button>
                  {search.q && (
                    <Button variant="ghost" type="button" className="library-search-clear" aria-label="Clear search" onClick={() => void navigate({ search: toLibrarySearch(filters, view, { item: search.item, shelf: search.shelf }), replace: true })}>
                      <X aria-hidden="true" size={14} strokeWidth={1.5} />
                    </Button>
                  )}
                </div>
                <FilterTrigger bar={bar} align="right" />
                <Button
                  variant="outline"
                  type="button"
                  className="toolbar-button desktop-actions"
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting((s) => !s);
                    setPicked(new Set());
                  }}
                >
                  <SquareCheck aria-hidden="true" strokeWidth={1.5} />
                  {selecting ? "Done" : "Select"}
                </Button>
                <div className="desktop-actions"><SaveAsShelf rule={currentRule} onSaved={goToShelf} /></div>
                <PhoneActions><SaveAsShelf rule={currentRule} onSaved={goToShelf} /><Button variant="outline" className="toolbar-button" type="button" aria-pressed={selecting} onClick={() => { setSelecting(s => !s); setPicked(new Set()); }}>{selecting ? "Done selecting" : "Select"}</Button></PhoneActions>
              </div>
            </div>
            {stats.isError && (
              <div className="library-notice" role="alert">
                Counts didn't load
                <Button variant="ghost" type="button" className="library-notice-action" onClick={() => void stats.refetch()}>Retry</Button>
              </div>
            )}
            {search.shelf && (
              <div className="shelf-header">
                {viewing ? (
                  <>
                    <span className="shelf-header-label">Rule</span>
                    <span className="shelf-header-rule">{hasRule(viewing.filters) ? describeRule(viewing.filters, isTopic).join(" · ") : "Saves added by hand"}</span>
                    <Button variant="ghost" type="button" className="shelf-header-edit" onClick={() => openShelfDialog({ shelf: viewing })}>
                      <SlidersHorizontal aria-hidden="true" strokeWidth={1.5} />
                      Edit
                    </Button>
                  </>
                ) : shelves.isSuccess ? (
                  <span className="shelf-header-rule">This shelf no longer exists</span>
                ) : null}
              </div>
            )}
            <div className={`workspace-filter-row${bar.anyApplied ? " has-filters" : ""}`}><FilterChips bar={bar} matched={!library.hasNextPage && !library.isPending && !library.isError ? items.length : null} />
            </div><SemanticSearchNotice query={search.q} status={library.semantic} />
          </div>

          <div className="library-content">
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
            <div role="alert" style={{ color: "var(--muted)", fontSize: "var(--text-body)", padding: 12 }}>
              {library.error instanceof Error ? library.error.message : "The library could not be loaded."}
              <Button variant="ghost" type="button" onClick={() => void library.refetch()} style={{ marginLeft: 10, border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text-dim)", padding: "5px 9px", cursor: "pointer" }}>Retry</Button>
            </div>
          )}

          {!library.isPending && !library.isError && items.length === 0 && (
            <div style={{ padding: "40px 12px", color: "var(--muted)", fontSize: "var(--text-body)" }}>
              <div style={{ color: "var(--text-dim)" }}>{search.q ? `No results for “${search.q}”` : bar.anyApplied ? "Nothing matches these filters" : search.shelf ? "Nothing on this shelf yet" : "Nothing saved yet"}</div>
              <div style={{ fontSize: "var(--text-meta)", color: "var(--muted)", marginTop: 4 }}>
                {search.q ? "Try fewer words or clear a filter" : bar.anyApplied ? "Clear a filter to see more" : search.shelf ? (viewing && hasRule(viewing.filters) ? "No saves match its rule yet" : "Add saves with Add to shelf, or save filters as a rule") : "Save a page, post or star with the Anansi extension"}
              </div>
            </div>
          )}

          {!firstLoad && !search.q && view === "grid" && (
            /*
              Columns packed shortest-first rather than a CSS grid. Grid rows
              are as tall as their tallest member, so a 137px card beside a
              535px one leaves 400px of hole.
            */
            <div ref={masonry.ref} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
              {masonry.buckets.map((bucket, column) => (
                <div key={column} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
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

          {!firstLoad && (search.q || view === "row") && <RowView onChanged={() => { void queryClient.invalidateQueries({queryKey: libraryKeys.pages()}); }} items={items} onOpen={openItem} />}
          {!firstLoad && !search.q && view === "timeline" && <TimelineView items={items} onOpen={openItem} />}
          <div ref={sentinel} style={{ height: 40 }} />
            {library.isFetchingNextPage && items.length > 0 && (
              <LoadMoreSkeleton />
            )}
            {library.isFetchNextPageError && (
              <div role="alert" style={{ display: "flex", alignItems: "center", gap: 9, color: "#f2a7a7", fontSize: "var(--text-body)", padding: 8 }}>
                More results could not be loaded.
                <Button variant="ghost" type="button" onClick={() => void library.fetchNextPage()} style={{ border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text-dim)", padding: "4px 8px", cursor: "pointer" }}>Retry</Button>
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
          void navigate({ search: toLibrarySearch(filters, view, { q: query, shelf: search.shelf }), replace: true });
        }}
        onFilters={(next) => setFilters({ ...filters, ...next })}
        onView={setView}
        onSelect={() => { setSelecting(true); setPicked(new Set()); }}
      />
      <Detail id={search.item ?? null} focusNote={focusNoteId === search.item} onClose={() => { setFocusNoteId(null); void navigate({ search: { ...search, item: undefined }, replace: true }); }} />
    </div>
    </ShelfViewContext.Provider>
  );
}
