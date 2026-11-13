import type { SearchHit } from "@anansi/db";
import { useSidebar } from "@anansi/ui/components/sidebar";
import { useNavigate } from "@tanstack/react-router";
import { Archive, BookMarked, BookPlus, CheckSquare, Columns3, LayoutGrid, ListFilter, PanelLeft, Rows3, Search, Server, Settings, Sparkles, Users, Waypoints } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, shortDate, type Creator, type ItemQuery } from "../lib/api.ts";
import { useShelves } from "../lib/shelf-queries.ts";
import { openShelfDialog } from "../lib/shelves.ts";
import { topicColor } from "../lib/tag-colors.ts";
import { ShelfIcon } from "./shelf-icons.tsx";
import { useDebouncedValue } from "../lib/use-debounced-value.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { Avatar } from "./avatar.tsx";
import { Bone, useSlowLoad } from "./skeleton.tsx";
import { SourceMark } from "./sourcemark.tsx";
import { formatCount } from "../lib/format.ts";

/**
 * ⌘K.
 *
 * One input over five groups: saves, authors, topics, shelves, then the places and
 * actions of the app. The arrow keys walk all of them as one list, so the
 * keyboard never has to know where a group ends. The results area has a fixed
 * height and every state (typing, loading, empty, failed) draws inside it, so
 * nothing below the input moves while you type.
 *
 * No open or close animation: this is opened many times a day, and from the
 * keyboard.
 */

export type PaletteView = "grid" | "row" | "timeline";

interface Entry {
	id: string;
	group: "Saves" | "Authors" | "Topics" | "Shelves" | "Go to" | "Actions";
	label: string;
	meta?: ReactNode;
	icon: ReactNode;
	keys?: string[];
	run: (event: { newTab: boolean }) => void;
	/** Lowercase text the query matches against, for local entries. */
	match?: string;
	detail?: string;
}

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

function isMac(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function modKey(): string {
	return isMac() ? "⌘" : "Ctrl";
}

export function Palette({ open, onClose, onOpen, onSearch, total, filters, onFilters, onView, onSelect }: {
	open: boolean;
	onClose: () => void;
	onOpen: (hit: SearchHit) => void;
	onSearch: (query: string) => void;
	total: number;
	filters: ItemQuery;
	/** Replace the library's filters (a topic or an author picked here). */
	onFilters?: (next: Pick<ItemQuery, "tag" | "author">) => void;
	onView?: (view: PaletteView) => void;
	onSelect?: () => void;
}) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [authors, setAuthors] = useState<Creator[]>([]);
	const [topics, setTopics] = useState<{ label: string; count: number }[]>([]);
	const [cursor, setCursor] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const dialog = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const navigate = useNavigate();
	const sidebar = useSidebar();
	const listId = useId();
	const mod = modKey();
	const shelves = useShelves();

	useDialogFocus(open, dialog, input, onClose);
	const slow = useSlowLoad(loading, 150);

	// Fresh every time it opens.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setCursor(0);
		const controller = new AbortController();
		api.tags(controller.signal)
			.then((result) => setTopics(result.tags.filter((tag) => tag.kind === "topic" && tag.count > 0).sort((a, b) => b.count - a.count)))
			.catch(() => setTopics([]));
		return () => controller.abort();
	}, [open]);

	// One request once typing settles, not one per key: every search also embeds
	// the query for meaning-based matching, so a keystroke-paced stream is real work.
	const typed = query.trim();
	const settled = useDebouncedValue(typed, 300);
	const searchTerm = typed.length < 2 || settled.length < 2 ? "" : settled;
	const waiting = typed.length >= 2 && settled !== typed;

	useEffect(() => {
		if (!open) return;
		if (!searchTerm) {
			setHits([]);
			setAuthors([]);
			setError(null);
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		Promise.all([
			api.search(searchTerm, { ...filters, cursor: null, limit: 6 }, controller.signal),
			api.creators({ query: searchTerm, limit: 4 }, controller.signal).catch(() => ({ creators: [] as Creator[] })),
		])
			.then(([result, people]) => {
				setHits(result.items);
				setAuthors(people.creators.filter((creator) => creator.authorHandle));
			})
			.catch((reason: Error) => {
				if (reason.name !== "AbortError") {
					setHits([]);
					setAuthors([]);
					setError(reason.message || "Search failed");
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [filters, open, searchTerm, attempt]);

	const go = (to: string, search?: Record<string, unknown>, hash?: string) => {
		onClose();
		void navigate({ to, search: search as never, hash });
	};

	const entries = useMemo<Entry[]>(() => {
		const needle = typed.toLowerCase();
		const local = (entry: Entry) => !needle || (entry.match ?? entry.label.toLowerCase()).includes(needle);

		const saves: Entry[] = hits.map((hit) => ({
			id: `save:${hit.id}`,
			group: "Saves",
			label: hit.title ?? hit.authorName ?? hit.author ?? "Untitled save",
			detail: hit.title ? hit.excerpt : undefined,
			meta: hit.postedAt ? shortDate(hit.postedAt) : undefined,
			icon: <SourceMark source={hit.source} size={16} />,
			run: ({ newTab }) => (newTab ? window.open(hit.url, "_blank", "noopener") : onOpen(hit)),
		}));
		if (typed.length >= 2) {
			saves.push({
				id: "save:all",
				group: "Saves",
				label: `Show every save matching “${typed}”`,
				icon: <Search {...ICON} />,
				run: () => onSearch(typed),
			});
		}

		const people: Entry[] = authors.map((creator) => ({
			id: `author:${creator.source}:${creator.authorHandle}`,
			group: "Authors",
			label: creator.authorName ?? creator.authorHandle ?? "",
			detail: creator.authorHandle ? `${creator.source === "reddit" ? "u/" : "@"}${creator.authorHandle}` : undefined,
			meta: <span className="tabular">{formatCount(creator.saves)}</span>,
			icon: <Avatar src={creator.authorAvatar} seed={creator.authorHandle ?? creator.authorName} name={creator.authorName} size={20} />,
			run: () => {
				onClose();
				onFilters?.({ author: [creator.authorHandle as string], tag: undefined });
			},
		}));

		const topicEntries: Entry[] = (needle ? topics.filter((topic) => topic.label.toLowerCase().includes(needle)) : []).slice(0, 5).map((topic) => ({
			id: `topic:${topic.label}`,
			group: "Topics",
			label: topic.label,
			meta: <span className="tabular">{formatCount(topic.count)}</span>,
			icon: <span aria-hidden="true" className="palette-topic-dot" style={{ background: topicColor(topic.label) }} />,
			run: () => {
				onClose();
				onFilters?.({ tag: [topic.label], author: undefined });
			},
		}));

		// Every shelf when the field is empty (there are few), the matching ones once typing.
		const shelfEntries: Entry[] = (shelves.data ?? []).filter((shelf) => !needle || shelf.name.toLowerCase().includes(needle)).slice(0, needle ? 6 : 8).map((shelf) => ({
			id: `shelf:${shelf.id}`,
			group: "Shelves",
			label: shelf.name,
			meta: <span className="tabular">{formatCount(shelf.count)}</span>,
			icon: <ShelfIcon icon={shelf.icon} color={shelf.color} />,
			run: () => go("/", { shelf: shelf.id }),
		}));

		const pages: Entry[] = ([
			{ id: "go:library", group: "Go to", label: "Library", icon: <BookMarked {...ICON} />, run: () => go("/") },
			{ id: "go:archived", group: "Go to", label: "Archived", icon: <Archive {...ICON} />, run: () => go("/", { archived: true }) },
			{ id: "go:authors", group: "Go to", label: "Authors", icon: <Users {...ICON} />, run: () => go("/creators") },
			{ id: "go:sources", group: "Go to", label: "Sources", icon: <Waypoints {...ICON} />, run: () => go("/sources") },
			{ id: "go:mcp", group: "Go to", label: "MCP server", icon: <Server {...ICON} />, run: () => go("/mcp") },
			{ id: "go:settings", group: "Go to", label: "Settings", icon: <Settings {...ICON} />, run: () => go("/settings") },
			{ id: "go:ai", group: "Go to", label: "AI settings", match: "ai settings tagging topics search", icon: <Sparkles {...ICON} />, run: () => go("/settings", undefined, "ai") },
		] as Entry[]).filter(local);

		const actions: Entry[] = ([
			onView && { id: "act:grid", group: "Actions", label: "Show as grid", match: "show as grid view", icon: <LayoutGrid {...ICON} />, run: () => { onClose(); onView("grid"); } },
			onView && { id: "act:rows", group: "Actions", label: "Show as rows", match: "show as rows list view", icon: <Rows3 {...ICON} />, run: () => { onClose(); onView("row"); } },
			onView && { id: "act:timeline", group: "Actions", label: "Show as timeline", match: "show as timeline view", icon: <Columns3 {...ICON} />, run: () => { onClose(); onView("timeline"); } },
			{ id: "act:new-shelf", group: "Actions", label: "New shelf", match: "new shelf create collection", icon: <BookPlus {...ICON} />, run: () => { onClose(); openShelfDialog({ onSaved: (shelf) => void navigate({ to: "/", search: { shelf: shelf.id } as never }) }); } },
			onSelect && { id: "act:select", group: "Actions", label: "Select saves", match: "select saves bulk", icon: <CheckSquare {...ICON} />, run: () => { onClose(); onSelect(); } },
			onFilters && hasFilters(filters) && { id: "act:clear", group: "Actions", label: "Clear filters", icon: <ListFilter {...ICON} />, run: () => { onClose(); onFilters({ tag: undefined, author: undefined }); } },
			{ id: "act:sidebar", group: "Actions", label: "Toggle sidebar", icon: <PanelLeft {...ICON} />, keys: [mod, "B"], run: () => { onClose(); sidebar.toggleSidebar(); } },
		].filter(Boolean) as Entry[]).filter(local);

		return [...saves, ...people, ...topicEntries, ...shelfEntries, ...pages, ...actions];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authors, filters, hits, mod, shelves.data, topics, typed]);

	useEffect(() => setCursor(0), [entries.length, typed]);

	const stateRef = useRef({ entries, cursor });
	stateRef.current = { entries, cursor };

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			const { entries, cursor } = stateRef.current;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setCursor((value) => (entries.length ? (value + 1) % entries.length : 0));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setCursor((value) => (entries.length ? (value - 1 + entries.length) % entries.length : 0));
			} else if (event.key === "Enter" && entries[cursor]) {
				event.preventDefault();
				entries[cursor]!.run({ newTab: event.metaKey || event.ctrlKey });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	// Keep the active row in view without smooth scrolling (keyboard-driven).
	useEffect(() => {
		list.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	if (!open) return null;

	const searching = typed.length >= 2 && (waiting || loading);
	const groups = [...new Set(entries.map((entry) => entry.group))];
	const active = entries[cursor];

	return (
		<div className="palette-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div ref={dialog} role="dialog" aria-modal="true" aria-label="Search and commands" tabIndex={-1} className="palette">
				<div className="palette-input-row">
					<Search {...ICON} className="palette-input-icon" />
					<input
						ref={input}
						className="palette-input"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={total > 0 ? `Search ${formatCount(total)} saves` : "Search saves"}
						aria-label="Search saves, authors, topics and pages"
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-activedescendant={active ? `${listId}-${cursor}` : undefined}
						autoComplete="off"
						spellCheck={false}
					/>
					<button type="button" className="palette-esc" onClick={onClose} aria-label="Close">
						<kbd className="keycap">esc</kbd>
					</button>
				</div>

				<div ref={list} id={listId} role="listbox" aria-label="Results" className="palette-results">
					{error && (
						<div role="alert" className="palette-note">
							<span>Search didn't respond</span>
							<button type="button" className="palette-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
						</div>
					)}
					{groups.map((group) => (
						<div key={group} role="group" aria-label={group} className="palette-group">
							<div className="palette-group-label" aria-hidden="true">{group}</div>
							{group === "Saves" && searching && slow && hits.length === 0 && <SavesLoading />}
							{entries.map((entry, index) => entry.group !== group ? null : (
								<div
									key={entry.id}
									id={`${listId}-${index}`}
									data-index={index}
									role="option"
									aria-selected={index === cursor}
									className="palette-item"
									data-kind={entry.group === "Saves" && entry.detail ? "save" : undefined}
									onMouseMove={() => index !== cursor && setCursor(index)}
									onClick={(event) => entry.run({ newTab: event.metaKey || event.ctrlKey })}
								>
									<span className="palette-item-icon">{entry.icon}</span>
									<span className="palette-item-text">
										<span className="palette-item-label">{entry.label}</span>
										{entry.detail && <span className="palette-item-detail">{entry.detail}</span>}
									</span>
									{entry.meta && <span className="palette-item-meta">{entry.meta}</span>}
									{entry.keys && <span className="palette-item-keys">{entry.keys.map((key) => <kbd key={key} className="keycap">{key}</kbd>)}</span>}
								</div>
							))}
						</div>
					))}
					{searching && slow && !groups.includes("Saves") && (
						<div className="palette-group"><div className="palette-group-label">Saves</div><SavesLoading /></div>
					)}
					{!searching && !error && typed.length >= 2 && entries.length === 0 && (
						<div className="palette-empty">
							<span>Nothing matches “{typed}”</span>
							<span className="palette-empty-hint">{hasFilters(filters) ? "Only the current filters are searched" : "Try a shorter word"}</span>
						</div>
					)}
				</div>

				<div className="palette-foot">
					<span><kbd className="keycap">↑</kbd><kbd className="keycap">↓</kbd> Move</span>
					<span><kbd className="keycap">↵</kbd> Open</span>
					<span><kbd className="keycap">{mod}</kbd><kbd className="keycap">↵</kbd> Open original</span>
					<span className="palette-scope">{hasFilters(filters) ? "Within current filters" : "Whole library"}</span>
				</div>
			</div>
		</div>
	);
}

function SavesLoading() {
	return (
		<div className="palette-loading" aria-label="Searching" role="status">
			{[0, 1, 2].map((row) => (
				<div key={row} className="palette-loading-row">
					<Bone width={16} height={16} radius={4} />
					<span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
						<Bone width={`${56 - row * 12}%`} height={10} />
						<Bone width={`${80 - row * 10}%`} height={8} />
					</span>
				</div>
			))}
		</div>
	);
}

function hasFilters(filters: ItemQuery): boolean {
	return !!(filters.source?.length || filters.author?.length || filters.type?.length || filters.tag?.length || filters.media || filters.archived || filters.favorite || filters.removed);
}
