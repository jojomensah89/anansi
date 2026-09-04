import { compact, mediaUrl, shortDate, type CardMedia, type ItemRow } from "../lib/api.ts";
import { Avatar } from "./avatar.tsx";
import { GithubRepoCard } from "./github-repo-card.tsx";
import { SourceMark } from "./sourcemark.tsx";

/**
 * One grid card.
 *
 * Media leads, and all of it. Showing one image from a four-image post
 * misrepresents the post — and a wall of text is what the library looked like
 * before thumbnails were served, which made a visual medium unbrowsable.
 *
 * A quote-tweet is nested rather than flattened, for the same reason the
 * drawer nests it: a quote's images are its own, and putting them in the
 * parent's grid makes it look like the parent posted them.
 *
 * Thumbnails come from our own copy, never hot-linked, so a deleted post still
 * renders and no request from the library tells the platform what you are
 * looking at.
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
  const media = item.media ?? [];
  const quoted = item.quoted;

  return (
    <div
      onClick={() => (selectable ? onToggle?.(item) : onOpen?.(item))}
      style={{
        background: "var(--card)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
        borderRadius: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        // Height follows content. A text-only save is a short card and a
        // four-image one is tall; forcing them equal pads the short ones with
        // dead space, and an uneven bottom edge is the better trade.
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

      {isRepo ? (
        <GithubRepoCard item={item} />
      ) : (
        <>
          {/*
            Who, then what they said, then what they showed — the order the post
            was written in, and the order the quote block below already used.
            Media first put a picture above the name of the person who posted
            it, so a card and the quote inside it disagreed about how a post is
            shaped.
          */}
          <div style={{ padding: "12px 12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Avatar src={item.authorAvatar} seed={item.author ?? item.authorName} size={22} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                {item.authorName && item.authorName !== item.author && (
                  <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.authorName}
                  </span>
                )}
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                  {item.author ?? "unknown"}
                </span>
              </span>
            </div>

            {item.excerpt.trim() && (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--text-dim)",
                  display: "-webkit-box",
                  WebkitLineClamp: media.length > 0 ? 4 : 8,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {item.excerpt}
              </div>
            )}
          </div>

          {/* Full bleed, which is why it is not inside the padded block above. */}
          {media.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <MediaGrid media={media} dim={selectable && !selected} />
            </div>
          )}

          <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
            {quoted && (
              <div
                style={{
                  border: "1px solid var(--edge)",
                  borderRadius: 8,
                  padding: 10,
                  background: "#0e1216",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Avatar src={quoted.avatar} seed={quoted.handle ?? quoted.name} size={17} />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{quoted.name ?? quoted.handle}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                    @{quoted.handle ?? "unknown"}
                  </span>
                </div>
                {quoted.text.trim() && (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--muted)",
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {quoted.text}
                  </div>
                )}
                {quoted.media.length > 0 && <MediaGrid media={quoted.media} inset />}
              </div>
            )}

            {/* The platform mark sits here, not in the top-right corner where a
                close button lives — up there it reads as "dismiss this". */}
            <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--faint)" }}>
              {/*
                Stated, not implied by absence. The item is still here because a
                library keeps what you saved; without a word saying why it looks
                identical to one that is still bookmarked.
              */}
              {item.platformSaved === 0 && (
                <span
                  title={
                    item.removedFromSourceAt
                      ? `No longer saved on the platform, since ${new Date(item.removedFromSourceAt * 1000).toLocaleDateString()}`
                      : "No longer saved on the platform"
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    color: "var(--fainter)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    padding: "1px 6px",
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                  unsaved
                </span>
              )}
              {item.metrics?.likes ? <span>{compact(item.metrics.likes)} ♥</span> : null}
              <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                {shortDate(item.postedAt)}
                <span style={{ color: "var(--fainter)", display: "flex" }}>
                  <SourceMark source={item.source} size={12} />
                </span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * All of it, laid out by how many there are.
 *
 * One fills the width, two share a row, three puts the first above the other
 * two, four goes 2×2. Past four X itself stops showing them, so neither does
 * this — it counts the rest instead.
 */
function MediaGrid({ media, dim, inset }: { media: CardMedia[]; dim?: boolean; inset?: boolean }) {
  const shown = media.slice(0, 4);
  const single = shown.length === 1;

  return (
    <div
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: single ? "1fr" : "repeat(2, 1fr)",
        gap: inset ? 4 : 2,
        background: "var(--rail)",
        borderRadius: inset ? 6 : 0,
        overflow: "hidden",
        opacity: dim ? 0.55 : 1,
      }}
    >
      {shown.map((m, i) => (
        <div
          key={m.key}
          style={{
            position: "relative",
            // A lone image keeps a readable shape; a set is squared off so
            // rows line up rather than stair-stepping.
            aspectRatio: single ? "16 / 10" : "1 / 1",
            gridColumn: shown.length === 3 && i === 0 ? "span 2" : undefined,
          }}
        >
          <img
            src={mediaUrl(m.key)}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {m.kind === "video_poster" && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 34, height: 34, borderRadius: "50%", background: "#0b0e11b3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--text)"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </span>
          )}
        </div>
      ))}
      {media.length > 4 && (
        <span
          className="mono"
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            background: "#0b0e11cc",
            color: "var(--text-dim)",
          }}
        >
          +{media.length - 4}
        </span>
      )}
    </div>
  );
}
