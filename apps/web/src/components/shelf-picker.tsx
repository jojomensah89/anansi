import { Input } from "@anansi/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@anansi/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search } from "lucide-react";
import { createContext, type ReactElement, type RefObject, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type Shelf } from "../lib/api.ts";
import { libraryKeys } from "../lib/library-query.ts";
import { useShelfMembership, useShelves } from "../lib/shelf-queries.ts";
import { openShelfDialog } from "../lib/shelves.ts";
import { Bone } from "./skeleton.tsx";
import { ShelfIcon } from "./shelf-icons.tsx";

/** The shelf the library is showing, if any: cards and the inspector offer "Remove from shelf" on it. */
export const ShelfViewContext = createContext<Shelf | null>(null);

export function useViewingShelf(): Shelf | null {
	return useContext(ShelfViewContext);
}

/**
 * Add to shelf.
 *
 * A small command list: type to narrow, arrows to move, Enter to choose. For
 * one save each shelf carries a check mark and choosing toggles it; for a
 * selection, choosing puts every selected save on that shelf. "New shelf…"
 * closes the list and opens the shelf dialog with the saves ready to add.
 */

export interface PickerRow {
	id: string;
	label: string;
	shelf?: Shelf;
}

/** Shelves matching the query, then the "New shelf…" row, always last. */
export function pickerRows(shelves: readonly Shelf[], query: string): PickerRow[] {
	const needle = query.trim().toLowerCase();
	const rows: PickerRow[] = shelves.filter((shelf) => !needle || shelf.name.toLowerCase().includes(needle)).map((shelf) => ({ id: shelf.id, label: shelf.name, shelf }));
	rows.push({ id: "new", label: needle ? `New shelf “${query.trim()}”` : "New shelf…" });
	return rows;
}

export function ShelfPicker({ itemIds, onDone }: { itemIds: string[]; onDone: () => void }) {
	const single = itemIds.length === 1 ? itemIds[0]! : null;
	const shelves = useShelves();
	const detail = useQuery({
		queryKey: libraryKeys.detail(single ?? ""),
		queryFn: ({ signal }) => api.item(single!, signal),
		enabled: !!single,
		retry: 1,
	});
	const membership = useShelfMembership();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);

	const rows = useMemo(() => pickerRows(shelves.data ?? [], query), [shelves.data, query]);
	const on = new Set(single ? (detail.data?.shelves ?? []) : []);
	const membershipKnown = !single || detail.isSuccess;

	useEffect(() => setActive(0), [query]);
	useEffect(() => {
		list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
	}, [active]);

	const choose = (row: PickerRow | undefined) => {
		if (!row) return;
		if (!row.shelf) {
			onDone();
			openShelfDialog({ itemIds, name: query.trim() || undefined });
			return;
		}
		if (single) {
			if (!membershipKnown) return;
			membership.mutate({ shelf: row.shelf, itemIds, on: !on.has(row.shelf.id), quiet: true });
			return;
		}
		membership.mutate({ shelf: row.shelf, itemIds, on: true });
		onDone();
	};

	const loading = shelves.isPending || (!!single && detail.isPending);

	return (
		<div className="shelf-picker">
			<div className="shelf-picker-search">
				<Search aria-hidden="true" size={16} strokeWidth={1.5} />
				<Input
					autoFocus
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Find a shelf"
					aria-label="Find a shelf"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
					autoComplete="off"
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setActive((value) => (value + 1) % rows.length);
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setActive((value) => (value - 1 + rows.length) % rows.length);
						} else if (event.key === "Enter") {
							event.preventDefault();
							choose(rows[active]);
						}
					}}
				/>
			</div>
			<div ref={list} id={listId} role="listbox" aria-label="Shelves" aria-multiselectable={single ? true : undefined} className="shelf-picker-list">
				{loading && (
					<div className="shelf-picker-loading" role="status" aria-label="Loading shelves">
						{[64, 48, 56].map((width) => <span key={width} className="shelf-picker-row"><Bone width={16} height={16} radius={4} /><Bone width={`${width}%`} height={10} /></span>)}
					</div>
				)}
				{!loading && rows.map((row, index) => {
					const checked = !!row.shelf && on.has(row.shelf.id);
					return (
						<div
							key={row.id}
							id={`${listId}-${index}`}
							data-index={index}
							role="option"
							aria-selected={single && row.shelf ? checked : index === active}
							data-active={index === active || undefined}
							data-new={row.shelf ? undefined : true}
							className="shelf-picker-row"
							onMouseMove={() => index !== active && setActive(index)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => choose(row)}
						>
							{row.shelf ? (
								<>
									{single && <span className="shelf-picker-check" aria-hidden="true">{checked && <Check size={16} strokeWidth={1.5} />}</span>}
									<ShelfIcon icon={row.shelf.icon} color={row.shelf.color} />
									<span className="shelf-picker-name">{row.label}</span>
									<span className="shelf-picker-count">{row.shelf.count.toLocaleString("en-GB")}</span>
								</>
							) : (
								<>
									{single && <span className="shelf-picker-check" aria-hidden="true" />}
									<Plus aria-hidden="true" size={16} strokeWidth={1.5} className="shelf-picker-plus" />
									<span className="shelf-picker-name">{row.label}</span>
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/**
 * The picker in a popover. Give it a `trigger` to own its button, or an
 * `anchor` to open beside something else (a card's menu button).
 */
export function ShelfPickerPopover({ itemIds, open, onOpenChange, trigger, anchor, side = "bottom", align = "end" }: {
	itemIds: string[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger?: ReactElement;
	anchor?: RefObject<HTMLElement | null>;
	side?: "top" | "bottom" | "left" | "right";
	align?: "start" | "center" | "end";
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{trigger && <PopoverTrigger render={trigger} />}
			<PopoverContent side={side} align={align} sideOffset={6} anchor={anchor} className="shelf-popover" aria-label="Add to shelf" onClick={(event) => event.stopPropagation()}>
				{open && <ShelfPicker itemIds={itemIds} onDone={() => onOpenChange(false)} />}
			</PopoverContent>
		</Popover>
	);
}
