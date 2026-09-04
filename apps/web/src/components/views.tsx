import { compact, mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";
import { SourceMark } from "./sourcemark.tsx";

/**
 * The three views that are not the grid.
 *
 * Each answers a different question, which is the only reason to have more
 * than one. Row: what is in here, densely, when you are scanning names and
 * text. Timeline: what was I saving in a given week. Mosaic: nothing but the
 * images, for finding the one you remember seeing rather than reading.
 */
// The view is part of the URL schema now, so its type lives with the schema.
export type { ViewMode } from "../lib/library-search.ts";
import type { ViewMode } from "../lib/library-search.ts";

/* ---------------------------------------------------------------- Row --- */

export function RowView({ items, onOpen }: { items: ItemRow[]; onOpen: (i: ItemRow) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {items.map((item) => {
        const thumb = item.media?.[0] ?? item.quoted?.media?.[0];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 13,
              padding: "12px 8px",
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid var(--line-soft)",
              cursor: "pointer",
              font: "inherit",
              color: "inherit",
            }}
          >
            {thumb ? (
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
              <span style={{ width: 64, height: 64, borderRadius: 6, background: "var(--card)", flexShrink: 0 }} />
            )}

            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {item.authorAvatar && (
                  <img src={item.authorAvatar} alt="" width={16} height={16} loading="lazy" style={{ borderRadius: "50%", objectFit: "cover" }} />
                )}
                <span style={{ fontSize: 12.5 }}>{item.authorName ?? item.author}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                  @{item.author}
                </span>
                {item.quoted && (
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)", border: "1px solid var(--line)", borderRadius: 3, padding: "1px 5px" }}>
                    quote
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: 12.5,
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

            <span className="mono" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--faint)", flexShrink: 0, paddingTop: 2 }}>
              {item.metrics?.likes ? <span>{compact(item.metrics.likes)} ♥</span> : null}
              <span>{shortDate(item.postedAt)}</span>
              <span style={{ color: "var(--fainter)", display: "flex" }}>
                <SourceMark source={item.source} size={12} />
              </span>
            </span>
          </button>
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
            <span style={{ fontSize: 13, fontWeight: 600 }}>{group.label}</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
              {group.items.length} posted
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

/* ------------------------------------------------------------- Mosaic --- */

/**
 * Images only, nothing else.
 *
 * For the case where you remember what a thing looked like and not a word of
 * it. Items with no media are simply absent — a mosaic with text tiles in it
 * is a worse grid, not a mosaic.
 */
export function MosaicView({ items, onOpen }: { items: ItemRow[]; onOpen: (i: ItemRow) => void }) {
  const tiles = items.flatMap((item) =>
    [...(item.media ?? []), ...(item.quoted?.media ?? [])].map((m) => ({ item, media: m })),
  );

  if (tiles.length === 0) {
    return (
      <div style={{ padding: "40px 12px", color: "var(--muted)", fontSize: 13.5 }}>
        Nothing here has media.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
      {tiles.map(({ item, media }) => (
        <button
          key={item.id + media.key}
          type="button"
          onClick={() => onOpen(item)}
          title={`@${item.author} — ${item.excerpt.slice(0, 90)}`}
          style={{
            position: "relative",
            aspectRatio: "1 / 1",
            padding: 0,
            border: "none",
            borderRadius: 5,
            overflow: "hidden",
            cursor: "pointer",
            background: "var(--rail)",
          }}
        >
          <img
            src={mediaUrl(media.key)}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {media.kind === "video_poster" && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 30, height: 30, borderRadius: "50%", background: "#0b0e11b3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--text)"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------- the switcher --- */

/**
 * Each icon draws what the view does to the same set of items: packed
 * rectangles, stacked lines, a column against a date, a wall of pictures. The
 * label stays — an icon alone would be a guess, and these four are close
 * enough in meaning to be worth spelling out.
 */
function TabIcon({ d }: { d: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const MODES: { value: ViewMode; label: string; icon: string }[] = [
  // Four panes, deliberately uneven, the way the masonry packs them.
  { value: "grid", label: "Grid", icon: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z" },
  // A thumbnail and its lines.
  { value: "row", label: "Row", icon: "M4 6h4v4H4zM10 6h10M10 10h7M4 14h4v4H4zM10 14h10M10 18h7" },
  // A spine with events hanging off it.
  { value: "timeline", label: "Timeline", icon: "M7 3v18M7 7h11M7 13h8M7 18h12" },
  // Pictures, not text.
  { value: "mosaic", label: "Mosaic", icon: "M4 5h16v14H4zM4 14l4-4 5 5M14 12l2-2 4 4" },
];

export function ViewTabs({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          style={{
            height: 30,
            padding: "0 11px",
            borderRadius: 5,
            border: "1px solid transparent",
            background: value === m.value ? "var(--raised)" : "transparent",
            color: value === m.value ? "var(--text)" : "var(--muted)",
            fontSize: 12.5,
            cursor: "pointer",
            font: "inherit",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <TabIcon d={m.icon} />
          {m.label}
        </button>
      ))}
    </div>
  );
}
