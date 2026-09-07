import { Checkbox } from "@anansi/ui/components/checkbox";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api.ts";

export interface TagOption {
	label: string;
	color: string;
	count: number;
	kind: "topic" | "custom";
}

type TagPopoverMode = "add" | "overflow";

function normalize(label: string) {
	return label.trim().toLowerCase();
}

export function TagPopover({
	itemId,
	current,
	onChanged,
	mode = "add",
	overflowCount,
}: {
	itemId: string;
	current: string[];
	onChanged: () => void;
	mode?: TagPopoverMode;
	overflowCount?: number;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [tags, setTags] = useState<TagOption[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(() => new Set(current.map(normalize)));
	const [placement, setPlacement] = useState<{ left: number; bottom: number } | null>(null);
	const anchor = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);

	const currentKey = current.join("\u0000");
	useEffect(() => setSelected(new Set(current.map(normalize))), [currentKey]);

	const updatePlacement = useCallback(() => {
		const rect = anchor.current?.getBoundingClientRect();
		if (!rect) return;
		const width = 248;
		const gutter = 8;
		const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
		setPlacement({
			left: Math.min(Math.max(gutter, rect.right - width), maxLeft),
			bottom: Math.max(gutter, window.innerHeight - rect.top + 8),
		});
	}, []);

	const close = useCallback(() => {
		setOpen(false);
		window.requestAnimationFrame(() => trigger.current?.focus());
	}, []);

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		updatePlacement();
		api.tags(controller.signal).then((response) => setTags(response.tags)).catch(() => {});
		const focusFrame = window.requestAnimationFrame(() => input.current?.focus());
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && (anchor.current?.contains(target) || popup.current?.contains(target))) return;
			close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", updatePlacement);
		window.addEventListener("scroll", updatePlacement, true);
		return () => {
			controller.abort();
			window.cancelAnimationFrame(focusFrame);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", updatePlacement);
			window.removeEventListener("scroll", updatePlacement, true);
		};
	}, [close, open, updatePlacement]);

	const options = useMemo(() => {
		const byLabel = new Map(tags.map((tag) => [normalize(tag.label), tag]));
		for (const label of current) {
			const key = normalize(label);
			if (!byLabel.has(key)) byLabel.set(key, { label: key, color: "#6b7280", count: 0, kind: "custom" });
		}
		return [...byLabel.values()].sort((a, b) => Number(b.kind === "topic") - Number(a.kind === "topic") || b.count - a.count || a.label.localeCompare(b.label));
	}, [current, tags]);
	const needle = normalize(query);
	const visible = options.filter((tag) => !needle || normalize(tag.label).includes(needle));
	const groups = [
		{ label: "Topics", items: visible.filter((tag) => tag.kind === "topic") },
		{ label: "Custom tags", items: visible.filter((tag) => tag.kind === "custom") },
	];
	const existing = options.some((tag) => normalize(tag.label) === needle);

	const toggleTag = async (label: string, next: boolean) => {
		const value = normalize(label);
		if (!value || busy) return;
		setBusy(value);
		setSelected((previous) => {
			const nextSet = new Set(previous);
			if (next) nextSet.add(value);
			else nextSet.delete(value);
			return nextSet;
		});
		try {
			if (next) await api.addItemTag(itemId, value);
			else await api.removeItemTag(itemId, value);
			onChanged();
			setQuery("");
		} catch (error) {
			setSelected((previous) => {
				const nextSet = new Set(previous);
				if (next) nextSet.delete(value);
				else nextSet.add(value);
				return nextSet;
			});
			toast.error("Could not update tag", { description: error instanceof Error ? error.message : "The request failed." });
		} finally {
			setBusy(null);
		}
	};

	const popupContent = open ? (
		<div
			ref={popup}
			role="dialog"
			aria-label="Choose tags"
			style={{ position: "fixed", left: placement?.left ?? 8, bottom: placement?.bottom ?? 8, zIndex: 100, width: 248, padding: 9, border: "1px solid var(--edge-strong)", borderRadius: 8, background: "#111519", boxShadow: "0 18px 40px -14px #000" }}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			<input
				ref={input}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="Search or create a tag"
				maxLength={100}
				style={{ width: "100%", boxSizing: "border-box", height: 30, padding: "0 8px", border: "1px solid var(--edge)", borderRadius: 5, background: "var(--card)", color: "var(--text)", font: "inherit", fontSize: 11.5, outline: "none" }}
			/>
			<div style={{ maxHeight: 230, overflowY: "auto", marginTop: 7, display: "flex", flexDirection: "column", gap: 2 }}>
				{groups.map((group) => group.items.length > 0 && <div key={group.label}>
					<div className="mono" style={{ padding: "7px 7px 3px", color: "var(--fainter)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{group.label}</div>
					{group.items.map((tag) => {
					const checked = selected.has(normalize(tag.label));
					return (
						<label key={tag.label} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 30, padding: "0 7px", borderRadius: 4, background: checked ? "#ffffff0d" : "transparent", color: checked ? "var(--text-dim)" : "var(--muted)", cursor: busy ? "wait" : "pointer", fontSize: 11.5 }} onClick={(event) => event.stopPropagation()}>
							<Checkbox checked={checked} disabled={busy !== null} onCheckedChange={(next) => void toggleTag(tag.label, next)} className="size-4 rounded-sm" />
							<span style={{ width: 7, height: 7, borderRadius: "50%", background: tag.color || "#6b7280", flexShrink: 0 }} />
							<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{tag.label}</span>
							<span className="mono" style={{ fontSize: 9.5, color: "var(--fainter)" }}>{tag.count || ""}</span>
						</label>
					);
					})}
				</div>)}
				{needle && !existing && <button type="button" disabled={busy !== null} onClick={() => void toggleTag(needle, true)} style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 30, padding: "0 7px", marginTop: 3, border: "1px solid var(--line)", borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", textAlign: "left", font: "inherit", fontSize: 11.5 }}>＋ Create “{needle}”</button>}
				{!needle && visible.length === 0 && <span style={{ padding: "7px", color: "var(--faint)", fontSize: 11 }}>No tags yet</span>}
			</div>
		</div>
	) : null;

	return (
		<span ref={anchor} className={mode === "add" ? "anansi-tag-add" : "anansi-tag-overflow"} style={{ position: "relative", display: "inline-flex" }} onClick={(event) => event.stopPropagation()}>
			<button
				ref={trigger}
				type="button"
				onClick={() => {
					if (open) close();
					else {
						setSelected(new Set(current.map(normalize)));
						setOpen(true);
					}
				}}
				aria-expanded={open}
				aria-label={mode === "overflow" ? `Show ${overflowCount ?? 0} more tags` : "Add tags"}
				className="mono"
				style={mode === "overflow" ? { border: "1px solid var(--line)", borderRadius: 5, background: "var(--raised)", color: "var(--faint)", padding: "2px 7px", fontSize: 10, cursor: "pointer", fontFamily: "var(--mono)" } : { border: "1px dashed var(--edge-strong)", borderRadius: 5, background: "transparent", color: "var(--faint)", padding: "2px 7px", fontSize: 10, cursor: "pointer", fontFamily: "var(--mono)" }}
			>
				{mode === "overflow" ? `+${overflowCount ?? 0}` : "+ Add tags"}
			</button>
			{typeof document !== "undefined" && popupContent ? createPortal(popupContent, document.body) : null}
		</span>
	);
}
