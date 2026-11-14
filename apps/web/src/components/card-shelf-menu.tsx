import { Button } from "@anansi/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@anansi/ui/components/dropdown-menu";
import { BookMinus, BookPlus, Ellipsis } from "lucide-react";
import { useRef, useState } from "react";
import type { Shelf } from "../lib/api.ts";
import { useShelfMembership } from "../lib/shelf-queries.ts";
import { ShelfPickerPopover, useViewingShelf } from "./shelf-picker.tsx";

/**
 * A card's own menu: Add to shelf…, and Remove from the shelf being viewed.
 *
 * The picker opens beside the same button once the menu has closed, so the
 * eye stays in one place and focus lands in the picker's search field.
 */
export function CardShelfMenu({ itemId, title, disabled }: { itemId: string; title: string; disabled?: boolean }) {
	const viewing = useViewingShelf();
	const [menu, setMenu] = useState(false);
	const [picker, setPicker] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);

	return (
		<span className="card-shelf-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
			<DropdownMenu open={menu} onOpenChange={setMenu}>
				<DropdownMenuTrigger
					render={<Button ref={anchor} variant="ghost" type="button" className="capture-card-more" aria-label={`More actions for ${title}`} disabled={disabled} data-open={menu || picker || undefined} />}
				>
					<Ellipsis aria-hidden="true" size={14} strokeWidth={1.5} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={6} className="shelf-menu">
					<DropdownMenuItem onClick={() => setTimeout(() => setPicker(true), 0)}>
						<BookPlus aria-hidden="true" strokeWidth={1.5} />
						Add to shelf…
					</DropdownMenuItem>
					{viewing && <RemoveFromShelfItem shelf={viewing} itemId={itemId} />}
				</DropdownMenuContent>
			</DropdownMenu>
			<ShelfPickerPopover itemIds={[itemId]} open={picker} onOpenChange={setPicker} anchor={anchor} />
		</span>
	);
}

/** Only mounted while the menu is open, so a closed card needs no query client. */
function RemoveFromShelfItem({ shelf, itemId }: { shelf: Shelf; itemId: string }) {
	const membership = useShelfMembership();
	return (
		<DropdownMenuItem onClick={() => membership.mutate({ shelf, itemIds: [itemId], on: false })}>
			<BookMinus aria-hidden="true" strokeWidth={1.5} />
			Remove from {shelf.name}
		</DropdownMenuItem>
	);
}
