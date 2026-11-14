import { Badge } from "@anansi/ui/components/badge";
import { Button } from "@anansi/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@anansi/ui/components/popover";
import { isTopic, topicColor, useTagKinds } from "../lib/tag-colors.ts";

/**
 * A tag, the same everywhere it is shown: cards, rows, the inspector, menus.
 *
 * The chip stays neutral. An AI topic adds one small dot in its own stable
 * colour so topics can be told apart at a glance; the owner's own tags have no
 * dot, which is how the two kinds read differently without a legend. Stored
 * tag colours are ignored: they were assigned automatically and were loud.
 */
export function TagChip({ label, kind }: { label: string; kind?: "topic" | "custom" }) {
	const kinds = useTagKinds();
	const topic = kind ? kind === "topic" : isTopic(kinds, label);
	return (
		<Badge variant="secondary" className="anansi-tag-chip" data-kind={topic ? "topic" : "custom"} title={label}>
			{topic && <TagDot label={label} />}
			{label}
		</Badge>
	);
}

/** The topic's dot on its own, for menus that already draw their own row. */
export function TagDot({ label }: { label: string }) {
	return <span aria-hidden="true" className="anansi-tag-dot" style={{ background: topicColor(label) }} />;
}

/** Whether a label is an AI topic, for callers that place the dot themselves. */
export function useIsTopic(): (label: string) => boolean {
	const kinds = useTagKinds();
	return (label) => isTopic(kinds, label);
}

/**
 * The tags a card had no room for.
 *
 * Read-only on purpose: "+3" answers "which three?", so it lists them with
 * their dots. Changing tags stays on the Add tags control beside it.
 */
export function TagOverflow({ labels }: { labels: string[] }) {
	const kinds = useTagKinds();
	if (labels.length === 0) return null;
	return (
		<span className="anansi-tag-overflow" onClick={(event) => event.stopPropagation()}>
			<Popover>
				<PopoverTrigger
					render={<Button variant="ghost" />}
					className="anansi-tag-more"
					aria-label={`Show ${labels.length} more ${labels.length === 1 ? "tag" : "tags"}`}
				>
					+{labels.length}
				</PopoverTrigger>
				<PopoverContent side="top" align="start" sideOffset={6} className="tag-overflow-menu" onClick={(event) => event.stopPropagation()}>
					<ul className="tag-overflow-list">
						{labels.map((label) => (
							<li key={label} className="tag-overflow-item">
								<span className="tag-overflow-dot">{isTopic(kinds, label) && <TagDot label={label} />}</span>
								<span className="tag-overflow-label">{label}</span>
							</li>
						))}
					</ul>
				</PopoverContent>
			</Popover>
		</span>
	);
}
