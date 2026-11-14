import { Button } from "@anansi/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@anansi/ui/components/toggle-group";
import { CardFooter } from "./card.tsx";
import { WebPreviewCard } from "./web-preview-card.tsx";
import { mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";
import { Avatar } from "./avatar.tsx";
import { SourceMark } from "./sourcemark.tsx";

/**
 * The two views that are not the grid.
 *
 * Each answers a different question, which is the only reason to have more
 * than one. Row: what is in here, densely, when you are scanning names and
 * text. Timeline: what was I saving in a given week.
 */
// The view is part of the URL schema now, so its type lives with the schema.
export type { ViewMode } from "../lib/library-search.ts";
import type { ViewMode } from "../lib/library-search.ts";

/* ---------------------------------------------------------------- Row --- */

const label = (item: ItemRow) => item.title ?? item.authorName ?? item.author ?? "saved item";

export function RowView({ items, onOpen, onChanged }: { items: ItemRow[]; onChanged?: () => void; onOpen: (i: ItemRow) => void }) {
  return (
    <div className="library-rows">
      {items.map((item) => {
        const thumb = item.media?.[0] ?? item.quoted?.media?.[0];
        return (
          <article key={item.id} className="library-row" aria-label={label(item)}>
            <Button variant="ghost" type="button" className="anansi-card-open" aria-label={`Open ${label(item)}`} onClick={() => onOpen(item)} />
            {item.source === "web" ? <WebPreviewCard item={item} compact onPreview={onChanged} footer={<CardFooter item={item} onOpen={onOpen} onChanged={()=>onChanged?.()} />} /> : thumb ? (
              <span style={{ position: "relative", flexShrink: 0 }}>
                <img
                  src={mediaUrl(thumb.key)}
                  alt=""
                  loading="lazy"
                  style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, display: "block", background: "var(--rail)" }}
                />
                {thumb.kind === "video_poster" && (
                  <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--text)" style={{ filter: "drop-shadow(0 1px 3px #000)" }}>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                )}
              </span>
            ) : (
              <span aria-hidden="true" style={{ width: 64, height: 64, borderRadius: 8, background: "var(--raised)", flexShrink: 0, display: "grid", placeItems: "center" }}><SourceMark source={item.source} faviconUrl={item.media?.find(m => m.kind === "favicon")?.key ? mediaUrl(item.media.find(m => m.kind === "favicon")!.key) : undefined} size={24} /></span>
            )}

            {item.source !== "web" && <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Avatar src={item.authorAvatar} seed={item.author ?? item.authorName} name={item.authorName} size={16} />
                <span style={{ fontSize: "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.authorName ?? item.author}</span>
                {item.author && item.author !== (item.authorName ?? item.author) && <span style={{ fontSize: "var(--text-meta)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {item.source === "reddit" ? "u/" : item.source === "github" ? "" : "@"}{item.author}
                </span>}
                {item.quoted && (
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "0 6px" }}>
                    Quote
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: "var(--text-body)",
                  lineHeight: 1.5,
                  color: "var(--text-dim)",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {item.excerpt}
              </span>
            </span>

            }
            {item.source !== "web" && <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "var(--text-meta)", color: "var(--muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0, paddingTop: 2 }}>
              <span style={{ whiteSpace: "nowrap" }}>{shortDate(item.postedAt)}</span>
              {thumb && <span style={{ color: "var(--fainter)", display: "flex" }}>
                <SourceMark source={item.source} faviconUrl={item.media?.find(m => m.kind === "favicon")?.key ? mediaUrl(item.media.find(m => m.kind === "favicon")!.key) : undefined} size={20} />
              </span>}
              {/* The placeholder tile already shows the mark; keep the column so dates still line up. */}
              {!thumb && <span aria-hidden="true" style={{ width: 20, flexShrink: 0 }} />}
            </span>}
          </article>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- Timeline --- */

/**
 * Grouped by the month a thing was posted.
 *
 * Not by saved-at, deliberately: every backfilled item shares one import
 * timestamp, so grouping by it would produce a single heading called "today"
 * over the entire library. Posted-at is the date that actually varies, and
 * the header says which it is rather than letting you assume.
 */
export function TimelineView({ items, onOpen }: { items: ItemRow[]; onOpen: (i: ItemRow) => void }) {
  /**
   * The query returns these in date order (`order=posted`), so grouping the
   * sequence as it arrives is correct and, unlike a client-side sort, stays
   * correct as more pages load: page two continues where page one ended
   * rather than reshuffling everything above it.
   */
  const groups: { label: string; items: ItemRow[] }[] = [];

  for (const item of items) {
    const label = item.postedAt
      ? new Date(item.postedAt * 1000).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : "undated";
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {groups.map((group) => (
        <div key={group.label + group.items[0]?.id}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 12,
              position: "sticky",
              top: 0,
              background: "var(--ink)",
              paddingBottom: 6,
              zIndex: 1,
            }}
          >
            <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>{group.label}</span>
            <span style={{ fontSize: "var(--text-meta)", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
              {group.items.length}<span className="sr-only"> saves</span>
            </span>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 0, paddingLeft: 13, borderLeft: "1px solid var(--line)" }}>
            <RowView items={group.items} onOpen={onOpen} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------- the switcher --- */

/**
 * Each icon draws what the view does to the same set of items: packed
 * rectangles, stacked lines, and a column against a date. The label stays
 * beside it on wide screens; on a phone the icons stand alone and the name
 * moves to the accessible label.
 */
function TabIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const MODES: { value: ViewMode; label: string; icon: string }[] = [
  // Four panes, deliberately uneven, the way the masonry packs them.
  { value: "grid", label: "Grid", icon: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z" },
  // A thumbnail and its lines.
  { value: "row", label: "Rows", icon: "M4 6h4v4H4zM10 6h10M10 10h7M4 14h4v4H4zM10 14h10M10 18h7" },
  // A spine with events hanging off it.
  { value: "timeline", label: "Timeline", icon: "M7 3v18M7 7h11M7 13h8M7 18h12" },
];

export function ViewTabs({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(values) => { if (values[0]) onChange(values[0] as ViewMode); }}
      aria-label="Library view"
      className="view-tabs"
      spacing={0}
    >
      {MODES.map((m) => (
        <ToggleGroupItem key={m.value} value={m.value} aria-label={m.label} className="view-tab">
          <TabIcon d={m.icon} />
          <span className="view-tab-label">{m.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
