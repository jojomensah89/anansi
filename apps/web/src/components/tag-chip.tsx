import { Badge } from "@anansi/ui/components/badge";

/**
 * A tag, the same everywhere it is shown: cards, rows, the inspector.
 *
 * Neutral on purpose. Stored tag colours were assigned automatically, so a hue
 * on one chip implied an importance nobody chose; the content carries colour.
 */
export function TagChip({ label }: { label: string }) {
	return <Badge variant="secondary" className="anansi-tag-chip" title={label}>{label}</Badge>;
}
