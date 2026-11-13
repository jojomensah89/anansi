import {
	AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@anansi/ui/components/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@anansi/ui/components/dropdown-menu";
import { Input } from "@anansi/ui/components/input";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@anansi/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@anansi/ui/components/tooltip";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { Shelf, ShelfSuggestion } from "../lib/api.ts";
import { validateLibrarySearch } from "../lib/library-search.ts";
import { useDeleteShelf, useDismissSuggestion, useMoveShelf, useRenameShelf, useSaveShelf, useShelfSuggestions, useShelves } from "../lib/shelf-queries.ts";
import {
	closeShelfDialog, dropIndex, openShelfDialog, ruleFromFilters, suggestionToShelf, useShelfDialogRequest, visibleSuggestion,
} from "../lib/shelves.ts";
import { topicColor } from "../lib/tag-colors.ts";
import { ShelfDialog } from "./shelf-dialog.tsx";
import { ShelfIcon } from "./shelf-icons.tsx";

/**
 * The rail's shelves.
 *
 * One row per shelf, in the owner's order: its icon in its colour, its name,
 * its count. Rows drag to reorder (or Alt and an arrow key, or Move up/down in
 * the row's menu), and the order is drawn before the server confirms it. The
 * row's menu also opens on right-click. Below the shelves, at most one quiet
 * suggestion turns a busy topic into a shelf.
 *
 * The shelf dialog lives here because every page renders the rail.
 */

export function RailShelves() {
	const shelves = useShelves();
	const list = shelves.data ?? [];
	const suggestions = useShelfSuggestions();
	const suggestion = visibleSuggestion(suggestions.data?.suggestions);
	const location = useRouterState({ select: (state) => state.location });
	const navigate = useNavigate();
	const activeId = location.pathname === "/" ? validateLibrarySearch(location.search as Record<string, unknown>).shelf : undefined;
	const move = useMoveShelf();
	const rename = useRenameShelf();
	const remove = useDeleteShelf();
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Shelf | null>(null);
	const [menuOpen, setMenuOpen] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const focusAfterMove = useRef<string | null>(null);

	const goTo = (shelf: Pick<Shelf, "id">) => void navigate({ to: "/", search: { shelf: shelf.id } });
	const moveTo = (shelf: Shelf, to: number) => {
		const target = Math.max(0, Math.min(list.length - 1, to));
		if (target === list.findIndex((entry) => entry.id === shelf.id)) return;
		move(shelf.id, target);
		setAnnouncement(`${shelf.name} moved to position ${target + 1} of ${list.length}`);
	};
	const drag = useRowDrag(list.map((shelf) => shelf.id), (id, to) => {
		const shelf = list.find((entry) => entry.id === id);
		if (shelf) moveTo(shelf, to);
	});

	useEffect(() => {
		const id = focusAfterMove.current;
		if (!id) return;
		focusAfterMove.current = null;
		document.querySelector<HTMLElement>(`[data-shelf-row="${id}"] .rail-shelf-link`)?.focus();
	}, [list]);

	const onRowKey = (shelf: Shelf, index: number) => (event: KeyboardEvent) => {
		if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
		event.preventDefault();
		focusAfterMove.current = shelf.id;
		moveTo(shelf, index + (event.key === "ArrowUp" ? -1 : 1));
	};

	const request = useShelfDialogRequest();
	const currentRule = location.pathname === "/" ? (() => {
		const search = validateLibrarySearch(location.search as Record<string, unknown>);
		return ruleFromFilters({ ...search, query: search.q });
	})() : null;

	const phone = usePhone();
	const dialogs = (
		<>
			<ShelfDialog request={request} currentRule={currentRule} onClose={closeShelfDialog} />
			<AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
				<AlertDialogContent className="shelf-dialog shelf-confirm">
					<AlertDialogHeader>
						<AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
						<AlertDialogDescription>
							{deleting && deleting.count > 0
								? `The shelf goes away. Its ${deleting.count.toLocaleString("en-GB")} save${deleting.count === 1 ? "" : "s"} stay in your library.`
								: "The shelf goes away. Your saves stay in your library."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="shelf-footer">
						<AlertDialogCancel className="shelf-button">Cancel</AlertDialogCancel>
						<AlertDialogAction
							className="shelf-button shelf-button-danger"
							onClick={() => {
								const shelf = deleting;
								setDeleting(null);
								if (!shelf) return;
								remove.mutate(shelf);
								if (shelf.id === activeId) void navigate({ to: "/", search: {} });
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
	// On phones the rail is the bottom tab bar: no room for shelves there, so they live in ⌘K.
	// The dialogs stay mounted, since ⌘K and the add-to-shelf picker open them.
	if (phone) return dialogs;

	return (
		<SidebarGroup className="rail-shelves">
			<div className="rail-shelves-head">
				<SidebarGroupLabel className="rail-shelves-label">Shelves</SidebarGroupLabel>
				<Tooltip>
					<TooltipTrigger render={<button type="button" className="rail-shelves-add" aria-label="New shelf" onClick={() => openShelfDialog({ onSaved: goTo })} />}>
						<Plus aria-hidden="true" size={16} strokeWidth={1.5} />
					</TooltipTrigger>
					<TooltipContent side="right" sideOffset={6} className="frame-tooltip">New shelf</TooltipContent>
				</Tooltip>
			</div>
			<SidebarGroupContent>
				{shelves.isSuccess && list.length === 0 && (
					<div className="rail-shelves-empty">
						<p>Group saves by hand or by rule</p>
						<button type="button" className="rail-shelves-new" onClick={() => openShelfDialog({ onSaved: goTo })}>
							<Plus aria-hidden="true" size={16} strokeWidth={1.5} />
							New shelf
						</button>
					</div>
				)}
				<SidebarMenu className="rail-shelves-list" aria-describedby="rail-shelves-hint" data-dragging={drag.state ? true : undefined}>
					{list.map((shelf, index) => (
						<ShelfRow
							key={shelf.id}
							shelf={shelf}
							index={index}
							total={list.length}
							active={shelf.id === activeId}
							renaming={renaming === shelf.id}
							menuOpen={menuOpen === shelf.id}
							onMenu={(open) => setMenuOpen(open ? shelf.id : null)}
							style={drag.styleFor(shelf.id, index)}
							dragging={drag.state?.id === shelf.id}
							rowRef={drag.register(shelf.id)}
							pointer={drag.handlers(shelf.id)}
							onKeyDown={onRowKey(shelf, index)}
							onRename={() => setRenaming(shelf.id)}
							onRenamed={(name) => {
								setRenaming(null);
								const clean = name.trim();
								if (clean && clean !== shelf.name) rename.mutate({ id: shelf.id, name: clean });
							}}
							onEdit={() => openShelfDialog({ shelf })}
							onMove={(to) => { focusAfterMove.current = shelf.id; moveTo(shelf, to); }}
							onDelete={() => setDeleting(shelf)}
						/>
					))}
				</SidebarMenu>
				<span id="rail-shelves-hint" className="sr-only">Alt and the arrow keys move a shelf</span>
				<span className="sr-only" role="status" aria-live="polite">{announcement}</span>
				{suggestion && <SuggestionRow key={suggestion.topic} suggestion={suggestion} onCreated={goTo} />}
			</SidebarGroupContent>

			{dialogs}
		</SidebarGroup>
	);
}

interface RowProps {
	shelf: Shelf;
	index: number;
	total: number;
	active: boolean;
	renaming: boolean;
	menuOpen: boolean;
	dragging: boolean;
	style: React.CSSProperties | undefined;
	rowRef: (node: HTMLLIElement | null) => void;
	pointer: { onPointerDown: (event: PointerEvent<HTMLElement>) => void; onPointerMove: (event: PointerEvent<HTMLElement>) => void; onPointerUp: (event: PointerEvent<HTMLElement>) => void; onPointerCancel: () => void; onClickCapture: (event: React.MouseEvent) => void };
	onKeyDown: (event: KeyboardEvent) => void;
	onMenu: (open: boolean) => void;
	onRename: () => void;
	onRenamed: (name: string) => void;
	onEdit: () => void;
	onMove: (to: number) => void;
	onDelete: () => void;
}

function ShelfRow({ shelf, index, total, active, renaming, menuOpen, dragging, style, rowRef, pointer, onKeyDown, onMenu, onRename, onRenamed, onEdit, onMove, onDelete }: RowProps) {
	return (
		<SidebarMenuItem
			ref={rowRef}
			className="rail-shelf"
			data-shelf-row={shelf.id}
			data-dragging={dragging || undefined}
			data-menu-open={menuOpen || undefined}
			style={style}
			{...(renaming ? {} : pointer)}
			onContextMenu={(event) => {
				if (renaming) return;
				event.preventDefault();
				onMenu(true);
			}}
		>
			{renaming ? (
				<RenameField shelf={shelf} onDone={onRenamed} />
			) : (
				<SidebarMenuButton
					render={<Link to="/" search={{ shelf: shelf.id }} draggable={false} />}
					className="rail-shelf-link"
					isActive={active}
					tooltip={shelf.name}
					aria-label={`${shelf.name}, ${shelf.count.toLocaleString("en-GB")} saves`}
					aria-current={active ? "page" : undefined}
					onKeyDown={onKeyDown}
				>
					<ShelfIcon icon={shelf.icon} color={shelf.color} />
					<span className="anansi-sidebar-label">{shelf.name}</span>
					<span className="anansi-sidebar-count rail-shelf-count">{shelf.count.toLocaleString("en-GB")}</span>
				</SidebarMenuButton>
			)}
			{!renaming && (
				<DropdownMenu open={menuOpen} onOpenChange={onMenu}>
					<DropdownMenuTrigger render={<button type="button" className="rail-shelf-more" aria-label={`${shelf.name} options`} data-no-drag />}>
						<Ellipsis aria-hidden="true" size={16} strokeWidth={1.5} />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" side="right" sideOffset={8} className="shelf-menu">
						<DropdownMenuItem onClick={onRename}><Pencil aria-hidden="true" strokeWidth={1.5} />Rename</DropdownMenuItem>
						<DropdownMenuItem onClick={onEdit}><SlidersHorizontal aria-hidden="true" strokeWidth={1.5} />Edit</DropdownMenuItem>
						<DropdownMenuItem disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowUp aria-hidden="true" strokeWidth={1.5} />Move up</DropdownMenuItem>
						<DropdownMenuItem disabled={index === total - 1} onClick={() => onMove(index + 1)}><ArrowDown aria-hidden="true" strokeWidth={1.5} />Move down</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 aria-hidden="true" strokeWidth={1.5} />Delete</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</SidebarMenuItem>
	);
}

function RenameField({ shelf, onDone }: { shelf: Shelf; onDone: (name: string) => void }) {
	const [value, setValue] = useState(shelf.name);
	const done = useRef(false);
	const finish = (name: string) => {
		if (done.current) return;
		done.current = true;
		onDone(name);
	};
	return (
		<div className="rail-shelf-rename">
			<ShelfIcon icon={shelf.icon} color={shelf.color} />
			<Input
				autoFocus
				onFocus={(event) => event.currentTarget.select()}
				value={value}
				maxLength={80}
				aria-label={`Rename ${shelf.name}`}
				onChange={(event) => setValue(event.target.value)}
				onBlur={() => finish(value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") finish(value);
					if (event.key === "Escape") finish(shelf.name);
				}}
			/>
		</div>
	);
}

/**
 * One topic, offered as a shelf: "Make a shelf from • Design · 221".
 * Create uses the topic as the rule, its colour and a fitting icon.
 */
export function SuggestionRow({ suggestion, onCreated }: { suggestion: ShelfSuggestion; onCreated?: (shelf: Shelf) => void }) {
	const save = useSaveShelf();
	const dismiss = useDismissSuggestion();
	return (
		<div className="rail-suggestion" role="group" aria-label={`Suggested shelf: ${suggestion.label}`}>
			<p className="rail-suggestion-text">
				Make a shelf from <span aria-hidden="true" className="rail-suggestion-dot" style={{ background: topicColor(suggestion.label) }} />
				<span className="rail-suggestion-topic">{suggestion.label}</span>
				<span className="rail-suggestion-count"> · {suggestion.count.toLocaleString("en-GB")}</span>
			</p>
			<div className="rail-suggestion-actions">
				<button
					type="button"
					className="rail-suggestion-create"
					disabled={save.isPending}
					onClick={() => save.mutate({ input: suggestionToShelf(suggestion) }, {
						onSuccess: ({ shelf }) => onCreated?.(shelf),
						onError: (error) => toast.error("Couldn't create the shelf", { description: error instanceof Error ? error.message : undefined }),
					})}
				>
					Create
				</button>
				<button type="button" className="rail-suggestion-dismiss" aria-label={`Dismiss ${suggestion.label} suggestion`} onClick={() => dismiss.mutate(suggestion.topic)}>
					<X aria-hidden="true" size={14} strokeWidth={1.5} />
				</button>
			</div>
		</div>
	);
}

/* --------------------------------------------------------------- drag --- */

interface DragState { id: string; from: number; to: number; dy: number; step: number }
interface Session { id: string; from: number; startY: number; pointerId: number; rows: { top: number; height: number }[]; started: boolean; target: HTMLElement }

/**
 * Pointer drag for a vertical list, without a library.
 *
 * Nothing moves until the pointer travels 4px, so a click is still a click.
 * The dragged row follows the pointer; the others slide aside to show where it
 * will land. Escape puts everything back. Touch is left to scrolling: on a
 * touch screen the row menu's Move up and Move down do the same job.
 */
export function useRowDrag(ids: string[], onDrop: (id: string, to: number) => void) {
	const nodes = useRef(new Map<string, HTMLElement>());
	const session = useRef<Session | null>(null);
	const suppressClick = useRef(false);
	const [state, setState] = useState<DragState | null>(null);

	useEffect(() => {
		if (!state) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			session.current = null;
			setState(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state]);

	const register = (id: string) => (node: HTMLElement | null) => {
		if (node) nodes.current.set(id, node);
		else nodes.current.delete(id);
	};

	const handlers = (id: string) => ({
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			if (event.button !== 0 || event.pointerType === "touch") return;
			if ((event.target as Element).closest("[data-no-drag]")) return;
			const from = ids.indexOf(id);
			if (from < 0 || ids.length < 2) return;
			const rows = ids.map((key) => {
				const rect = nodes.current.get(key)?.getBoundingClientRect();
				return { top: rect?.top ?? 0, height: rect?.height ?? 0 };
			});
			session.current = { id, from, startY: event.clientY, pointerId: event.pointerId, rows, started: false, target: event.currentTarget };
		},
		onPointerMove: (event: PointerEvent<HTMLElement>) => {
			const current = session.current;
			if (!current || event.pointerId !== current.pointerId) return;
			const raw = event.clientY - current.startY;
			if (!current.started) {
				if (Math.abs(raw) < 4) return;
				current.started = true;
				current.target.setPointerCapture?.(event.pointerId);
			}
			const first = current.rows[0]!;
			const last = current.rows[current.rows.length - 1]!;
			const own = current.rows[current.from]!;
			// Keep the row within the list, so it never floats over the next section.
			const dy = Math.max(first.top - own.top, Math.min(last.top + last.height - own.top - own.height, raw));
			const to = dropIndex(current.rows, current.from, own.top + own.height / 2 + dy);
			const step = current.rows.length > 1 ? current.rows[1]!.top - current.rows[0]!.top : own.height;
			setState({ id: current.id, from: current.from, to, dy, step });
		},
		onPointerUp: (event: PointerEvent<HTMLElement>) => {
			const current = session.current;
			session.current = null;
			if (!current || !current.started || event.pointerId !== current.pointerId) return;
			suppressClick.current = true;
			const own = current.rows[current.from]!;
			const to = dropIndex(current.rows, current.from, own.top + own.height / 2 + (event.clientY - current.startY));
			setState(null);
			if (to !== current.from) onDrop(current.id, to);
		},
		onPointerCancel: () => {
			session.current = null;
			setState(null);
		},
		onClickCapture: (event: React.MouseEvent) => {
			if (!suppressClick.current) return;
			suppressClick.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
	});

	/** The dragged row follows the pointer; rows it passes slide one step the other way. */
	const styleFor = (id: string, index: number): React.CSSProperties | undefined => {
		if (!state) return undefined;
		if (id === state.id) return { transform: `translateY(${state.dy}px)` };
		const { step } = state;
		if (state.from < state.to && index > state.from && index <= state.to) return { transform: `translateY(${-step}px)` };
		if (state.to < state.from && index >= state.to && index < state.from) return { transform: `translateY(${step}px)` };
		return { transform: "translateY(0)" };
	};

	return { state, register, handlers, styleFor };
}

/** Phone width, where the rail becomes the bottom tab bar (matches the 640px breakpoint in the stylesheets). */
const PHONE_QUERY = "(max-width: 640px)";
function usePhone(): boolean {
	return useSyncExternalStore(
		(listener) => {
			if (typeof window === "undefined" || !window.matchMedia) return () => {};
			const query = window.matchMedia(PHONE_QUERY);
			query.addEventListener("change", listener);
			return () => query.removeEventListener("change", listener);
		},
		() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches,
		() => false,
	);
}
