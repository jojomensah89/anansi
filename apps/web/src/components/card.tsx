import { compact, mediaUrl, shortDate, type ItemRow } from "../lib/api.ts";

/**
 * One grid card.
 *
 * Media leads when there is media. A wall of text is what the library looked
 * like before thumbnails were served, and it made a visual medium unbrowsable
 * — you cannot recognise the post you are looking for from its first line.
 *
 * Thumbnails come from our own copy, never hot-linked: a deleted post still
 * renders, and no request from the library tells the platform what you are
 * looking at. Avatars are still remote, because we store the url and not the
 * image; they fail soft to a blank circle.
 */
export function Card({
  item,
  selectable,
  selected,
  onOpen,
  onToggle,
}: {
  item: ItemRow;
  selectable?: boolean;
  selected?: boolean;
  onOpen?: (item: ItemRow) => void;
  onToggle?: (item: ItemRow) => void;
}) {
  const isRepo = item.source === "github";
  const thumb = item.thumbKey ? mediaUrl(item.thumbKey) : null;
  const isVideo = item.thumbKind === "video_poster";
  const badge = ({ github: "gh", reddit: "r/", tiktok: "tt" } as Record<string, string>)[item.source] ?? "x";

  return (
    <div
      onClick={() => (selectable ? onToggle?.(item) : onOpen?.(item))}
      style={{
        background: "var(--card)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        // Height follows content. A text-only save is a short card and a
        // media one is tall; forcing them equal pads the short ones with
        // dead space and is a worse trade than an uneven bottom edge.
        height: thumb ? 372 : 268,
        cursor: "pointer",
        position: "relative",
        animation: "rise 160ms ease-out both",
      }}
    >
      {selectable && (
        <span
          style={{
            position: "absolute",
            top: 9,
            left: 9,
            zIndex: 2,
            width: 19,
            height: 19,
            borderRadius: 4,
            border: `1px solid ${selected ? "var(--accent)" : "var(--edge-strong)"}`,
            background: selected ? "var(--accent)" : "#0b0e11aa",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12l5 5L20 6" />
            </svg>
          )}
        </span>
      )}

      {thumb && (
        <div style={{ position: "relative", height: 196, flexShrink: 0, background: "var(--rail)" }}>
          <img
            src={thumb}
            alt=""
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              opacity: selectable && !selected ? 0.55 : 1,
            }}
          />
          {isVideo && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 38, height: 38, borderRadius: "50%", background: "#0b0e11b3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--text)"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </span>
          )}
          <span
            className="mono"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              fontSize: 9.5,
              color: "var(--text-dim)",
              background: "#0b0e11cc",
              border: "1px solid var(--edge-strong)",
              borderRadius: 3,
              padding: "2px 5px",
            }}
          >
            {badge}
          </span>
        </div>
      )}

      <div style={{ padding: 11, display: "flex", flexDirection: "column", gap: 9, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {item.authorAvatar ? (
            <img
              src={item.authorAvatar}
              alt=""
              width={20}
              height={20}
              loading="lazy"
              style={{ borderRadius: isRepo ? 4 : "50%", flexShrink: 0, objectFit: "cover", background: "var(--edge-strong)" }}
            />
          ) : (
            <span style={{ width: 20, height: 20, borderRadius: isRepo ? 4 : "50%", background: "var(--edge-strong)", flexShrink: 0 }} />
          )}
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            {item.authorName && item.authorName !== item.author && (
              <span style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.authorName}
              </span>
            )}
            <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
              {item.author ?? "unknown"}
            </span>
          </span>
          {!thumb && (
            <span
              className="mono"
              style={{
                marginLeft: "auto",
                fontSize: 9.5,
                color: "var(--faint)",
                border: "1px solid var(--edge)",
                borderRadius: 3,
                padding: "1px 4px",
              }}
            >
              {badge}
            </span>
          )}
        </div>

        {isRepo && item.title && (
          <div className="mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{item.title}</div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: isRepo ? "var(--muted)" : "var(--text-dim)",
            overflow: "hidden",
          }}
        >
          {item.excerpt}
        </div>

        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--faint)" }}>
          {item.metrics?.likes ? <span>{compact(item.metrics.likes)} ♥</span> : null}
          <span style={{ marginLeft: "auto" }}>{shortDate(item.postedAt)}</span>
        </div>
      </div>
    </div>
  );
}
