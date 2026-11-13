import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@anansi/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@anansi/ui/components/dialog";
import { Input } from "@anansi/ui/components/input";
import { Search } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SHELF_COLORS, type Shelf, type ShelfColor } from "../lib/api.ts";
import { sendMembershipAndCache, useSaveShelf } from "../lib/shelf-queries.ts";
import { describeRule, hasRule, shelfColor, type ShelfDialogRequest, type ShelfRule, topicShelfColor, topicShelfIcon } from "../lib/shelves.ts";
import { useIsTopic } from "./tag-chip.tsx";
import { searchShelfIcons, ShelfIcon } from "./shelf-icons.tsx";

/**
 * Create or edit a shelf.
 *
 * Name first, with the shelf's own icon beside it so every choice below shows
 * up where the shelf will be seen. Then its colour, its icon, and its rule:
 * the library filters that fill it on their own. A shelf without a rule is
 * filled by hand, which the dialog says once, quietly.
 */

const ICON_COLUMNS = 10;

const COLOR_NAMES: Record<ShelfColor, string> = {
	slate: "Slate", red: "Red", orange: "Orange", amber: "Amber", green: "Green",
	teal: "Teal", sky: "Sky", blue: "Blue", violet: "Violet", pink: "Pink",
};

export interface ShelfDialogProps {
	request: ShelfDialogRequest | null;
	/** The library's filters right now, when it has any: offered as the rule. */
	currentRule?: ShelfRule | null;
	onClose: () => void;
}

export function ShelfDialog({ request, currentRule, onClose }: ShelfDialogProps) {
	// The form leaves with its panel: the last request stays drawn while the
	// dialog fades out, and is let go only once the close has finished.
	const [shown, setShown] = useState(request);
	if (request !== null && request !== shown) setShown(request);
	return (
		<Dialog open={request !== null} onOpenChange={(open) => !open && onClose()} onOpenChangeComplete={(open) => { if (!open) setShown(null); }}>
			<DialogContent className="shelf-dialog" showCloseButton={false}>
				{shown && <ShelfForm key={shown.shelf?.id ?? "new"} request={shown} currentRule={currentRule ?? null} onClose={onClose} />}
			</DialogContent>
		</Dialog>
	);
}

/** The form alone, so it can be rendered and tested without a portal. */
export function ShelfForm({ request, currentRule, onClose, onSubmitted }: { request: ShelfDialogRequest; currentRule: ShelfRule | null; onClose: () => void; onSubmitted?: (shelf: Shelf) => void }) {
	const editing = request.shelf;
	const isTopic = useIsTopic();
	// A new shelf whose rule is one topic starts in that topic's colour, with a fitting icon.
	const topic = !editing && request.rule?.tag?.length === 1 && isTopic(request.rule.tag[0]!) ? request.rule.tag[0]! : null;
	const [name, setName] = useState(editing?.name ?? request.name ?? "");
	const [color, setColor] = useState<ShelfColor>(editing?.color ?? (topic ? topicShelfColor(topic) : "slate"));
	const [icon, setIcon] = useState(editing?.icon ?? (topic ? topicShelfIcon(topic) : "folder"));
	const [rule, setRule] = useState<ShelfRule>(editing?.filters ?? request.rule ?? {});
	const save = useSaveShelf();
	const client = useQueryClient();
	const nameId = useId();

	const parts = describeRule(rule, isTopic);
	const canUseCurrent = !!currentRule && hasRule(currentRule) && JSON.stringify(currentRule) !== JSON.stringify(rule);
	const trimmed = name.trim();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!trimmed || save.isPending) return;
		save.mutate(
			{ id: editing?.id, input: { name: trimmed, color, icon, filters: rule } },
			{
				onSuccess: async ({ shelf }) => {
					if (request.itemIds?.length) {
						try {
							const result = await sendMembershipAndCache(client, { shelf, itemIds: request.itemIds, on: true });
							if (result.shelf) shelf = result.shelf;
						} catch (error) {
							toast.error(`Couldn't add to ${shelf.name}`, { description: error instanceof Error ? error.message : undefined });
						}
					}
					request.onSaved?.(shelf);
					onSubmitted?.(shelf);
					onClose();
				},
				onError: (error) => toast.error(editing ? "Couldn't save the shelf" : "Couldn't create the shelf", { description: error instanceof Error ? error.message : undefined }),
			},
		);
	};

	return (
		<form className="shelf-form" onSubmit={submit} aria-label={editing ? "Edit shelf" : "New shelf"}>
			<DialogHeader>
				<DialogTitle>{editing ? "Edit shelf" : "New shelf"}</DialogTitle>
			</DialogHeader>

			<div className="shelf-name-row">
				<span className="shelf-name-icon" aria-hidden="true"><ShelfIcon icon={icon} color={color} size={16} /></span>
				<label htmlFor={nameId} className="sr-only">Name</label>
				<Input id={nameId} className="shelf-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" maxLength={80} autoFocus autoComplete="off" />
			</div>

			<ColorField value={color} onChange={setColor} />
			<IconField value={icon} color={color} onChange={setIcon} />

			<section className="shelf-field" aria-labelledby={`${nameId}-rule`}>
				<div className="shelf-field-label" id={`${nameId}-rule`}>Rule</div>
				{parts.length > 0 ? (
					<div className="shelf-rule">
						<span className="shelf-rule-text">{parts.join(" · ")}</span>
						<Button type="button" variant="ghost" className="shelf-link" onClick={() => setRule({})}>Remove rule</Button>
					</div>
				) : (
					<p className="shelf-hint">Add saves with Add to shelf, or save filters as a rule</p>
				)}
				{canUseCurrent && (
					<Button type="button" variant="ghost" className="shelf-link shelf-use-current" title={describeRule(currentRule, isTopic).join(" · ")} onClick={() => setRule(currentRule!)}>
						Use current filters
					</Button>
				)}
			</section>

			<DialogFooter className="shelf-footer">
				<Button type="button" variant="outline" className="shelf-button" onClick={onClose}>Cancel</Button>
				<Button type="submit" className="shelf-button shelf-button-primary" disabled={!trimmed || save.isPending}>{editing ? "Save" : "Create"}</Button>
			</DialogFooter>
		</form>
	);
}

/** Arrow keys walk a radio group and select as they go, like native radios. */
function moveFocus(event: KeyboardEvent<HTMLElement>, index: number, count: number, columns: number, select: (next: number) => void) {
	const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -index, End: count - 1 - index } as Record<string, number>)[event.key];
	if (step === undefined) return;
	event.preventDefault();
	const next = Math.max(0, Math.min(count - 1, index + step));
	select(next);
	const group = event.currentTarget.parentElement;
	group?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
}

function ColorField({ value, onChange }: { value: ShelfColor; onChange: (color: ShelfColor) => void }) {
	const labelId = useId();
	return (
		<section className="shelf-field">
			<div className="shelf-field-label" id={labelId}>Colour</div>
			<div role="radiogroup" aria-labelledby={labelId} className="shelf-swatches">
				{SHELF_COLORS.map((color, index) => (
					<button
						key={color}
						type="button"
						role="radio"
						aria-checked={value === color}
						aria-label={COLOR_NAMES[color]}
						tabIndex={value === color ? 0 : -1}
						className="shelf-swatch"
						onClick={() => onChange(color)}
						onKeyDown={(event) => moveFocus(event, index, SHELF_COLORS.length, SHELF_COLORS.length, (next) => onChange(SHELF_COLORS[next]!))}
					>
						<span style={{ background: shelfColor(color) }} />
					</button>
				))}
			</div>
		</section>
	);
}

function IconField({ value, color, onChange }: { value: string; color: ShelfColor; onChange: (icon: string) => void }) {
	const [query, setQuery] = useState("");
	const labelId = useId();
	const grid = useRef<HTMLDivElement>(null);
	const options = useMemo(() => searchShelfIcons(query), [query]);
	const selectedIndex = options.findIndex((option) => option.name === value);
	const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

	// Keep the chosen icon in view when the dialog opens on an existing shelf.
	useEffect(() => {
		grid.current?.querySelector<HTMLElement>("[aria-checked=true]")?.scrollIntoView?.({ block: "nearest" });
	}, []);

	return (
		<section className="shelf-field">
			<div className="shelf-field-label" id={labelId}>Icon</div>
			<div className="shelf-icon-search">
				<Search aria-hidden="true" size={16} strokeWidth={1.5} />
				<Input
					className="shelf-input"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" && options.length) {
							event.preventDefault();
							grid.current?.querySelectorAll<HTMLElement>("[role=radio]")[tabStop]?.focus();
						}
					}}
					placeholder="Search icons"
					aria-label="Search icons"
					autoComplete="off"
				/>
			</div>
			<div ref={grid} role="radiogroup" aria-labelledby={labelId} className="shelf-icon-grid">
				{options.map((option, index) => {
					const Icon = option.icon;
					const checked = option.name === value;
					return (
						<button
							key={option.name}
							type="button"
							role="radio"
							aria-checked={checked}
							aria-label={option.label}
							title={option.label}
							tabIndex={index === tabStop ? 0 : -1}
							className="shelf-icon-option"
							onClick={() => onChange(option.name)}
							onKeyDown={(event) => moveFocus(event, index, options.length, ICON_COLUMNS, (next) => onChange(options[next]!.name))}
						>
							<Icon aria-hidden="true" size={16} strokeWidth={1.5} style={checked ? { color: shelfColor(color) } : undefined} />
						</button>
					);
				})}
				{options.length === 0 && <p className="shelf-hint shelf-icon-empty">No icon matches “{query.trim()}”</p>}
			</div>
		</section>
	);
}
