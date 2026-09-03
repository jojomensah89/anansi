import { compact, shortDate, type ItemRow } from "../lib/api.ts";

/**
 * One grid card.
 *
 * Two shapes rather than one generic card: an X post leads with its text and
 * a GitHub repo leads with its full name, and forcing both through the same
 * template makes each read slightly wrong. The card is a link to the source,
 * not to a reader — this is not a Readwise competitor, items link out.
 */
export function Card({
  item, selected, onOpen,
}: {
  item: ItemRow; selected?: boolean; onOpen?: (item: ItemRow) => void;
}) {
  const isRepo = item.source === "github";

  return (
    <button
      type="button"
      onClick={() => onOpen?.(item)}
      style={{
        background: "var(--card)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
        borderRadius: 6, padding: 11, height: 268,
        display: "flex", flexDirection: "column", gap: 9,
        textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer",
        animation: "rise 160ms ease-out both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{
          width: 18, height: 18, borderRadius: isRepo ? 4 : "50%",
          background: "var(--edge-strong)", flexShrink: 0,
        }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.author ?? "unknown"}
        </span>
        <span className="mono" style={{
          marginLeft: "auto", fontSize: 9.5, color: "var(--faint)",
          border: "1px solid var(--edge)", borderRadius: 3, padding: "1px 4px",
        }}>
          {isRepo ? "gh" : "x"}
        </span>
      </div>

      {isRepo && item.title && (
        <div className="mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{item.title}</div>
      )}

      <div style={{
        flex: 1, minHeight: 0, fontSize: 12.5, lineHeight: 1.55,
        color: isRepo ? "var(--muted)" : "var(--text-dim)", overflow: "hidden",
      }}>
        {item.excerpt}
      </div>

      <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--faint)" }}>
        {isRepo ? (
          <span style={{ color: "var(--accent)" }}>★ {compact(item.score || undefined)}</span>
        ) : null}
        <span style={{ marginLeft: "auto" }}>{shortDate(item.postedAt)}</span>
      </div>
    </button>
  );
}
