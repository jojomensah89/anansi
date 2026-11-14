import { Button } from "@anansi/ui/components/button";
import { PhoneActions } from "../components/phone-actions.tsx";
import { Search, SlidersHorizontal, SquareCheck, X } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../components/card.tsx";
import { modKey as paletteModKey } from "../components/palette.tsx";
import { Detail } from "../components/detail.tsx";
import { FilterChips, FilterTrigger, useFilterBar, type FilterBar, type Filters } from "../components/filters.tsx";
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
import { api, type ItemRow, type SemanticSearchStatus, type Shelf } from "../lib/api.ts";
import { useShelves } from "../lib/shelf-queries.ts";
import { describeRule, hasRule, openShelfDialog, ruleFromFilters, type ShelfRule } from "../lib/shelves.ts";
import { expectIncomingSaves, libraryKeys, libraryStatsChanged, libraryStatsFingerprint, useLibraryQuery, useLibraryStats } from "../lib/library-query.ts";
import { useHideRemoved, useShowNsfw } from "../lib/settings.ts";
import { libraryFiltersOf, toLibrarySearch, validateLibrarySearch, type LibrarySearch } from "../lib/library-search.ts";
import { clearPicked, openPalette, setPicked, setSelecting, togglePicked, toggleSelecting, useIsPicked, usePicked, useSelecting } from "../lib/shell-state.ts";

export const Route = createFileRoute("/_app/")({
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
    <div role="status" aria-live="polite" className="library-semantic-notice">
      {notice.message}
      {notice.status.pending !== undefined && notice.status.pending > 0 && (
        <span className="mono library-semantic-pending">{notice.status.pending} pending</span>
      )}
    </div>
  );
}

/**
 * The Library.
 *
 * Search is an overlay and detail is a drawer, because both are things you do
 * *to* the library rather than places you go instead of it. The rail, the top
 * bar and ⌘K belong to the app shell (routes/_app.tsx); this page is the
 * toolbar, the results and the drawer.
 *
 * Pagination is keyset and infinite. Offset paging would silently drop or
 * repeat items whenever an import ran underneath a scroll, which is a thing
 * that will happen.
 */
function Library() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const view: ViewMode = search.view ?? "grid";
  const selecting = useSelecting();
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);

  const filters: Filters = useMemo(() => libraryFiltersOf(search) as Filters, [search]);

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

  const [hideRemoved] = useHideRemoved();
  const [showNsfw] = useShowNsfw();

  const ordering = view === "timeline" ? "posted" : "saved";
  // A shelf narrows the library like any filter, but it is not one of the bar's chips.
  const queryFilters = useMemo(() => (search.shelf ? { ...filters, shelf: search.shelf } : filters), [filters, search.shelf]);
  const library = useLibraryQuery({ filters: queryFilters, query: search.q ?? "", order: ordering, hideRemoved, showNsfw });
  const shelves = useShelves();
  const viewing = search.shelf ? (shelves.data?.find((shelf) => shelf.id === search.shelf) ?? null) : null;
  const items = library.items;
  const stats = useLibraryStats();

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

  const bar = useFilterBar({ filters, onChange: setFilters, bySource: stats.data?.bySource ?? {} });

  // Select mode belongs to this page: Escape leaves it, and so does leaving the page.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelecting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);
  useEffect(() => () => setSelecting(false), []);

  /** A bulk action changes the set under you, so reload rather than patch. */
  const afterBulk = useCallback(() => {
    setSelecting(false);
    void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
  }, [queryClient]);

  const afterCardChange = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: libraryKeys.pages() });
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
  }, [queryClient]);

  // The updater form keeps this stable across searches, so cards can be memoised.
  const openItem = useCallback((item: Pick<ItemRow, "id">, focusNote = false) => {
    setFocusNoteId(focusNote ? item.id : null);
    void navigate({ search: (previous: LibrarySearch) => ({ ...previous, item: item.id }) });
  }, [navigate]);

  const closeItem = useCallback(() => {
    setFocusNoteId(null);
    void navigate({ search: (previous: LibrarySearch) => ({ ...previous, item: undefined }), replace: true });
  }, [navigate]);

  /** What "Save as shelf" offers as the rule: the filters and search on screen. */
  const currentRule = useMemo(() => ruleFromFilters({ ...filters, query: search.q }), [filters, search.q]);
  const goToShelf = useCallback((shelf: { id: string }) => void navigate({ search: { shelf: shelf.id } }), [navigate]);
  const clearSearch = useCallback(
    () => void navigate({ search: toLibrarySearch(filters, view, { item: search.item, shelf: search.shelf }), replace: true }),
    [filters, navigate, search.item, search.shelf, view],
  );

  const matched = !library.hasNextPage && !library.isPending && !library.isError ? items.length : null;

  return (
    <ShelfViewContext.Provider value={viewing}>
      <div className="library-main">
        <div className="scroll library-scroll">
          <div className="library-toolbar-wrap">
            <LibraryToolbar
              view={view}
              onView={setView}
              query={search.q}
              onClearSearch={clearSearch}
              bar={bar}
              selecting={selecting}
              rule={currentRule}
              onShelfSaved={goToShelf}
            />
            {stats.isError && (
              <div className="library-notice" role="alert">
                Counts didn't load
                <Button variant="ghost" type="button" className="library-notice-action" onClick={() => void stats.refetch()}>Retry</Button>
              </div>
            )}
            {search.shelf && <ShelfHeader shelf={viewing} missing={shelves.isSuccess && !viewing} />}
            <div className={`workspace-filter-row${bar.anyApplied ? " has-filters" : ""}`}>
              <FilterChips bar={bar} matched={matched} />
            </div>
            <SemanticSearchNotice query={search.q} status={library.semantic} />
          </div>

          <LibraryResults
            library={library}
            view={view}
            query={search.q}
            filtered={bar.anyApplied}
            shelf={search.shelf ? viewing ?? null : undefined}
            selecting={selecting}
            onOpen={openItem}
            onChanged={afterCardChange}
          />
        </div>
      </div>

      <LibrarySelectBar items={items} archived={!!filters.archived} onDone={afterBulk} />
      <Detail id={search.item ?? null} focusNote={focusNoteId === search.item} onClose={closeItem} />
    </ShelfViewContext.Provider>
  );
}

/* ------------------------------------------------------------ toolbar --- */

/**
 * One row of tools under the frame's top bar: the view you are in on the
 * left, then everything you can do to it. Applied filters get their own row
 * beneath, where they can wrap.
 */
function LibraryToolbar({ view, onView, query, onClearSearch, bar, selecting, rule, onShelfSaved }: {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  query: string | undefined;
  onClearSearch: () => void;
  bar: FilterBar;
  selecting: boolean;
  rule: ShelfRule;
  onShelfSaved: (shelf: Shelf) => void;
}) {
  // ⌘ on Apple keyboards, Ctrl elsewhere; decided after hydration.
  const [modKey, setModKey] = useState("⌘");
  useEffect(() => setModKey(paletteModKey() === "⌘" ? "⌘" : "Ctrl "), []);

  return (
    <div className="library-toolbar">
      <ViewTabs value={view} onChange={onView} />
      <div className="library-toolbar-end">
        <div className="library-search">
          <Button
            variant="outline"
            type="button"
            className="library-search-field"
            onClick={openPalette}
            aria-label={query ? `Search: ${query}` : "Search"}
            aria-keyshortcuts="Meta+K Control+K"
            data-filled={query ? true : undefined}
          >
            <Search aria-hidden="true" size={16} strokeWidth={1.5} />
            <span className="library-search-text">{query ? query : "Search"}</span>
            <kbd className="keycap library-search-keys">{modKey}K</kbd>
          </Button>
          {query && (
            <Button variant="ghost" type="button" className="library-search-clear" aria-label="Clear search" onClick={onClearSearch}>
              <X aria-hidden="true" size={14} strokeWidth={1.5} />
            </Button>
          )}
        </div>
        <FilterTrigger bar={bar} align="right" />
        <Button variant="outline" type="button" className="toolbar-button desktop-actions" aria-pressed={selecting} onClick={toggleSelecting}>
          <SquareCheck aria-hidden="true" strokeWidth={1.5} />
          {selecting ? "Done" : "Select"}
        </Button>
        <div className="desktop-actions"><SaveAsShelf rule={rule} onSaved={onShelfSaved} /></div>
        <PhoneActions>
          <SaveAsShelf rule={rule} onSaved={onShelfSaved} />
          <Button variant="outline" className="toolbar-button" type="button" aria-pressed={selecting} onClick={toggleSelecting}>{selecting ? "Done selecting" : "Select"}</Button>
        </PhoneActions>
      </div>
    </div>
  );
}

/** A shelf's rule in words, with its edit button; or a note that it has gone. */
function ShelfHeader({ shelf, missing }: { shelf: Shelf | null; missing: boolean }) {
  const isTopic = useIsTopic();
  return (
    <div className="shelf-header">
      {shelf ? (
        <>
          <span className="shelf-header-label">Rule</span>
          <span className="shelf-header-rule">{hasRule(shelf.filters) ? describeRule(shelf.filters, isTopic).join(" · ") : "Saves added by hand"}</span>
          <Button variant="ghost" type="button" className="shelf-header-edit" onClick={() => openShelfDialog({ shelf })}>
            <SlidersHorizontal aria-hidden="true" strokeWidth={1.5} />
            Edit
          </Button>
        </>
      ) : missing ? (
        <span className="shelf-header-rule">This shelf no longer exists</span>
      ) : null}
    </div>
  );
}

/** Reads the picked set itself, so ticking a card re-renders this bar and that card only. */
function LibrarySelectBar({ items, archived, onDone }: { items: ItemRow[]; archived: boolean; onDone: () => void }) {
  const selecting = useSelecting();
  const picked = usePicked();
  if (!selecting || picked.size === 0) return null;
  return (
    <SelectBar
      ids={[...picked]}
      onClear={clearPicked}
      onSelectAll={() => setPicked(items.map((item) => item.id))}
      loaded={items.length}
      archived={archived}
      onDone={onDone}
    />
  );
}

/* ------------------------------------------------------------ results --- */

type LibraryResult = ReturnType<typeof useLibraryQuery>;

/**
 * The saves, in the chosen view, with every state they can be in.
 *
 * The first page and the next page are different waits. An empty screen
 * needs a shape; a screen you are already reading needs a line at the bottom,
 * not a wall of grey pushing your place away. Neither deserves one for a load
 * too fast to notice.
 */
function LibraryResults({ library, view, query, filtered, shelf, selecting, onOpen, onChanged }: {
  library: LibraryResult;
  view: ViewMode;
  query: string | undefined;
  filtered: boolean;
  /** undefined: not a shelf view; null: a shelf that is loading or gone. */
  shelf: Shelf | null | undefined;
  selecting: boolean;
  onOpen: (item: Pick<ItemRow, "id">, focusNote?: boolean) => void;
  onChanged: () => void;
}) {
  const items = library.items;
  const masonry = useMasonry(items, 340);
  const firstLoad = useSlowLoad(library.isPending && items.length === 0);
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = library;

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(node);
    return () => io.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const grid = !query && view === "grid";
  const rows = !!query || view === "row";
  const timeline = !query && view === "timeline";

  return (
    <div className="library-content">
      {firstLoad && !library.isError && grid && <GridSkeleton columns={masonry.columns} containerRef={masonry.ref} />}
      {firstLoad && !library.isError && rows && <RowsSkeleton />}
      {firstLoad && !library.isError && timeline && <RowsSkeleton count={6} />}
      {library.isError && (
        <div role="alert" className="library-state library-state-error">
          {library.error instanceof Error ? library.error.message : "The library could not be loaded."}
          <Button variant="outline" type="button" className="library-state-retry" onClick={() => void library.refetch()}>Retry</Button>
        </div>
      )}

      {!library.isPending && !library.isError && items.length === 0 && (
        <LibraryEmpty query={query} filtered={filtered} shelf={shelf} />
      )}

      {!firstLoad && grid && (
        /*
          Columns packed shortest-first rather than a CSS grid. Grid rows
          are as tall as their tallest member, so a 137px card beside a
          535px one leaves 400px of hole.
        */
        <div ref={masonry.ref} className="library-masonry">
          {masonry.buckets.map((bucket, column) => (
            <div key={column} className="library-masonry-column">
              {bucket.map((item) => (
                <PickableCard key={item.id} item={item} selecting={selecting} onOpen={onOpen} onChanged={onChanged} />
              ))}
            </div>
          ))}
        </div>
      )}

      {!firstLoad && rows && <RowView items={items} onOpen={onOpen} onChanged={onChanged} />}
      {!firstLoad && timeline && <TimelineView items={items} onOpen={onOpen} />}
      <div ref={sentinel} className="library-sentinel" />
      {library.isFetchingNextPage && items.length > 0 && <LoadMoreSkeleton />}
      {library.isFetchNextPageError && (
        <div role="alert" className="library-state library-state-more">
          More results could not be loaded.
          <Button variant="outline" type="button" className="library-state-retry" onClick={() => void library.fetchNextPage()}>Retry</Button>
        </div>
      )}
    </div>
  );
}

/** Subscribes to its own pick, so ticking one card leaves the rest alone. */
const PickableCard = memo(function PickableCard({ item, selecting, onOpen, onChanged }: {
  item: ItemRow;
  selecting: boolean;
  onOpen: (item: Pick<ItemRow, "id">, focusNote?: boolean) => void;
  onChanged: () => void;
}) {
  const selected = useIsPicked(item.id);
  return <Card item={item} selectable={selecting} selected={selected} onOpen={onOpen} onToggle={togglePicked} onChanged={onChanged} />;
});

function LibraryEmpty({ query, filtered, shelf }: { query: string | undefined; filtered: boolean; shelf: Shelf | null | undefined }) {
  const title = query ? `No results for “${query}”` : filtered ? "Nothing matches these filters" : shelf !== undefined ? "Nothing on this shelf yet" : "Nothing saved yet";
  const hint = query
    ? "Try fewer words or clear a filter"
    : filtered
      ? "Clear a filter to see more"
      : shelf !== undefined
        ? (shelf && hasRule(shelf.filters) ? "No saves match its rule yet" : "Add saves with Add to shelf, or save filters as a rule")
        : "Save a page, post or star with the Anansi extension";
  return (
    <div className="library-state library-state-empty">
      <div className="library-state-title">{title}</div>
      <div className="library-state-hint">{hint}</div>
    </div>
  );
}
