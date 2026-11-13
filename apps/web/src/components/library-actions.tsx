import { Button } from "@anansi/ui/components/button";
import { BookPlus } from "lucide-react";
import type { Shelf } from "../lib/api.ts";
import { hasRule, openShelfDialog, type ShelfRule } from "../lib/shelves.ts";

/**
 * Save as shelf.
 *
 * The library's filters become a shelf's rule: the dialog opens with them set,
 * so naming it is the only step left. Shelves themselves live in the rail.
 */
export function SaveAsShelf({ rule, onSaved, className = "toolbar-button" }: { rule: ShelfRule; onSaved?: (shelf: Shelf) => void; className?: string }) {
	const active = hasRule(rule);
	return (
		<Button
			variant="outline"
			type="button"
			className={className}
			disabled={!active}
			title={active ? undefined : "Filter the library first"}
			onClick={() => openShelfDialog({ rule, onSaved })}
		>
			<BookPlus aria-hidden="true" strokeWidth={1.5} />
			Save as shelf
		</Button>
	);
}
