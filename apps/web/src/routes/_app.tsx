import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { AppTopBar, ProgressPill } from "../components/app-frame.tsx";
import { Palette, type PaletteView } from "../components/palette.tsx";
import { Rail } from "../components/rail.tsx";
import { ShelfDialog } from "../components/shelf-dialog.tsx";
import type { ItemQuery } from "../lib/api.ts";
import { useLibraryStats } from "../lib/library-query.ts";
import { libraryFiltersOf, toLibrarySearch, validateLibrarySearch, type LibrarySearch } from "../lib/library-search.ts";
import { closeShelfDialog, ruleFromFilters, useShelfDialogRequest } from "../lib/shelves.ts";
import { closePalette, openPalette, setSelecting, usePaletteOpen } from "../lib/shell-state.ts";

/**
 * The app shell: the rail, the top bar, the progress pill, ⌘K, the shelf
 * dialog and the library's counts, for every page.
 *
 * A pathless layout, so it stays mounted while you move between pages: the
 * rail keeps its scroll and its counts, and ⌘K works wherever you are. Pages
 * render only their own content into the Outlet, which the frame's grid
 * (styles/frame.css) places beside the rail and under the top bar.
 */
export const Route = createFileRoute("/_app")({ component: AppShell });

function AppShell() {
	const location = useRouterState({ select: (state) => state.location });
	const onLibrary = location.pathname === "/";
	const search: LibrarySearch = useMemo(
		() => (onLibrary ? validateLibrarySearch(location.search as Record<string, unknown>) : {}),
		[location.search, onLibrary],
	);
	const stats = useLibraryStats();

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				openPalette();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div className={`anansi-shell${onLibrary ? " capture-workspace" : ""}${search.item ? " inspector-open" : ""}`}>
			{/* The rail and the bars are siblings of the page so the frame's grid can place them. */}
			<Rail />
			<AppTopBar />
			<ProgressPill />
			<Outlet />
			<ShellPalette search={search} onLibrary={onLibrary} total={stats.data?.items ?? 0} />
			<ShellShelfDialog search={search} onLibrary={onLibrary} />
		</div>
	);
}

/**
 * ⌘K on every page. Its choices act on the library: on the Library they keep
 * the view and filters you have; anywhere else they open the Library with them.
 */
function ShellPalette({ search, onLibrary, total }: { search: LibrarySearch; onLibrary: boolean; total: number }) {
	const open = usePaletteOpen();
	const navigate = useNavigate();
	const filters = useMemo(() => libraryFiltersOf(search) as ItemQuery, [search]);
	const view = search.view ?? "grid";

	const toLibrary = useCallback(
		(next: LibrarySearch, replace = onLibrary) => void navigate({ to: "/", search: next, replace }),
		[navigate, onLibrary],
	);

	return (
		<Palette
			open={open}
			total={total}
			onClose={closePalette}
			filters={filters}
			onOpen={(hit) => {
				closePalette();
				toLibrary({ ...search, item: hit.id }, false);
			}}
			onSearch={(query) => {
				closePalette();
				toLibrary(toLibrarySearch(filters, view, { q: query, shelf: search.shelf }));
			}}
			onFilters={(next) => toLibrary(toLibrarySearch({ ...filters, ...next }, view, { q: search.q, item: search.item, shelf: search.shelf }))}
			onView={(next: PaletteView) => toLibrary(toLibrarySearch(filters, next, { q: search.q, item: search.item, shelf: search.shelf }))}
			onSelect={() => {
				if (!onLibrary) toLibrary({}, false);
				setSelecting(true);
			}}
		/>
	);
}

/** One shelf dialog for the app; "Save as shelf" offers the Library's filters as its rule. */
function ShellShelfDialog({ search, onLibrary }: { search: LibrarySearch; onLibrary: boolean }) {
	const request = useShelfDialogRequest();
	const currentRule = useMemo(() => (onLibrary ? ruleFromFilters({ ...search, query: search.q }) : null), [onLibrary, search]);
	return <ShelfDialog request={request} currentRule={currentRule} onClose={closeShelfDialog} />;
}
