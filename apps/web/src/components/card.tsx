import { Checkbox } from "@anansi/ui/components/checkbox";
import { Button } from "@anansi/ui/components/button";
import { WebPreviewCard, webDomain } from "./web-preview-card.tsx";
import { mediaUrl, shortDate, type CardMedia, type ItemRow } from "../lib/api.ts";
import { Avatar } from "./avatar.tsx";
import { GithubRepoCard } from "./github-repo-card.tsx";
import { SourceMark } from "./sourcemark.tsx";
import { TagPopover } from "./tag-popover.tsx";
import { TagChip, TagOverflow } from "./tag-chip.tsx";
import { Bookmark, Star } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { formatCount } from "../lib/format.ts";
import { CardShelfMenu } from "./card-shelf-menu.tsx";

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
export const Card = memo(function Card({
  item,
  selectable,
  selected,
  onOpen,
  onToggle,
  onChanged,
}: {
  item: ItemRow;
  selectable?: boolean;
  selected?: boolean;
  onOpen?: (item: ItemRow, focusNote?: boolean) => void;
  onToggle?: (item: ItemRow) => void;
  onChanged?: () => void;
}) {
  const isRepo = item.source === "github";
  const media = item.media ?? [];
  const quoted = item.quoted;
  const quotedText = typeof quoted?.text === "string" ? quoted.text : "";
  const quotedMedia = quoted?.media ?? [];
  const name = item.title ?? item.authorName ?? item.author ?? "saved item";

  const changed = () => {
		onChanged?.();
	};

	return (
		/*
		 * An article with one real button for its main action, stretched over the
		 * whole card so any part of it still opens (or, in Select mode, picks) the
		 * save. The footer's own controls sit above that button as siblings, so
		 * nothing interactive is nested inside another control.
		 */
		<article
		  data-source={item.source}
		  data-selected={selected || undefined}
		  className={`anansi-card${selectable ? " is-selecting" : ""}`}
		  aria-label={name}
		>
      <Button
        variant="ghost"
        type="button"
        className="anansi-card-open"
        aria-label={`${selectable ? (selected ? "Deselect" : "Select") : "Open"} ${name}`}
        aria-pressed={selectable ? !!selected : undefined}
        onClick={() => (selectable ? onToggle?.(item) : onOpen?.(item))}
      />
      {/* The button above carries the pick for assistive tech; this box only shows it. */}
      {selectable && <Checkbox aria-hidden="true" tabIndex={-1} checked={!!selected} onCheckedChange={()=>onToggle?.(item)} style={{position:"absolute",top:12,right:12,zIndex:3,width:20,height:20,background:selected?"var(--accent)":"var(--card)",color:"var(--accent-text-on-accent)"}} />}

      {!isRepo && <CardIdentity item={item} />}
      {item.source === "web" ? <WebPreviewCard item={item} onPreview={changed} footer={<CardFooter item={item} selectable={selectable} onOpen={onOpen} onChanged={changed} />} /> : isRepo ? (
		<>
			<GithubRepoCard item={item} footer={<CardFooter item={item} selectable={selectable} onOpen={onOpen} onChanged={changed} />} />
		</>
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
            {item.title && item.source !== "x" && item.source !== "tiktok" && <div style={{ fontSize:14, fontWeight:500, color:"var(--text)" }}>{item.title}</div>}

            {(item.excerpt.trim() || (item.source === "tiktok" && item.title)) && (
              <div
                style={{
                  fontSize: item.source === "x" ? 16 : "var(--text-body)",
                  lineHeight: 1.55,
                  color: "var(--text-dim)",
                  display: "-webkit-box",
                  WebkitLineClamp: item.source === "tiktok" ? 2 : media.length > 0 ? 4 : 8,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {item.excerpt.trim() || item.title}
              </div>
            )}
          </div>

          {/* Media gets its own gutter so the image never touches the card edge. */}
          {media.length > 0 && (
            <div style={{ margin: "10px 12px 0" }}>
              <MediaGrid topCrop={item.source === "tiktok"} media={media} dim={selectable && !selected} inset />
            </div>
          )}

          <div style={{ padding: quoted ? "10px 12px 12px" : 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {quoted && (
              <div
                style={{
                  border: "1px solid var(--edge)",
                  borderRadius: 8,
                  padding: 10,
                  background: "var(--rail)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Avatar src={quoted.avatar} seed={quoted.handle ?? quoted.name} name={quoted.name} size={17} />
                  <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>{quoted.name ?? quoted.handle}</span>
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--muted)" }}>
                    {quoted.handle ? `@${quoted.handle}` : null}
                  </span>
                </div>
                {quotedText.trim() && (
                  <div
                    style={{
                      fontSize: "var(--text-body)",
                      lineHeight: 1.5,
                      color: "var(--text-dim)",
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {quotedText}
                  </div>
                )}
                {quotedMedia.length > 0 && <MediaGrid media={quotedMedia} inset />}
              </div>
            )}


          </div>
          {item.source === "reddit" && <div className="reddit-metrics">{item.metrics?.score != null && <span>{formatCount(item.metrics.score)} points</span>}{item.metrics?.comments != null && <span>{formatCount(item.metrics.comments)} comments</span>}</div>}<CardFooter item={item} selectable={selectable} onOpen={onOpen} onChanged={changed} />
        </>
      )}
		</article>
	);
});

/**
 * Who the save is from. A web page has no author, so its site stands in: the
 * favicon in the avatar's place and the site's own name (the link preview's
 * site name, else the domain), said once.
 */
function CardIdentity({ item }: { item: ItemRow }) {
  if (item.source === "web") {
    const favicon = item.media?.find((m) => m.kind === "favicon")?.key;
    return (
      <div className="capture-card-identity">
        <span className="capture-card-site" aria-hidden="true"><SourceMark source="web" faviconUrl={favicon ? mediaUrl(favicon) : undefined} size={16} decorative /></span>
        <span>{item.authorName || webDomain(item.url)}</span>
      </div>
    );
  }
  return (
    <div className="capture-card-identity">
      <Avatar src={item.authorAvatar} seed={item.author ?? item.authorName} name={item.authorName} size={28} />
      <span>
        {item.source === "reddit" && item.subreddit ? `r/${item.subreddit}` : item.authorName ?? item.author}
        {item.source === "x" && item.author && <small className="post-handle">@{item.author}</small>}
        {item.source === "reddit" && item.author && <small className="post-handle">u/{item.author}</small>}
      </span>
    </div>
  );
}

/**
 * The card's last line: what you filed it under on the left, when and where on
 * the right.
 *
 * Add tags leads so the action is always in the same place; once a card has
 * tags it shrinks to its plus and the chips carry the line. As many whole
 * chips as fit, then a count that lists the rest; a chip is never cut. The
 * platform mark closes the line, once. GitHub cards draw their mark in their
 * own header and web cards lead with their site's favicon, so both skip it here.
 */
export function CardFooter({ item, selectable, onOpen, onChanged }: { item: ItemRow; selectable?: boolean; onOpen?: (item: ItemRow, focusNote?: boolean) => void; onChanged: () => void }) {
 const favicon = item.media?.find((m) => m.kind === "favicon")?.key;
 const markShown = item.source !== "github" && item.source !== "web";
 return <footer className="capture-card-footer" data-has-note={item.hasNote || undefined}>
 <CardOrganization item={item} tags={item.tags ?? []} onChanged={onChanged} />
 <span className="capture-card-meta">
 {item.platformSaved === 0 && <span className="capture-card-removed" title="Removed at source">Removed</span>}
 {item.favorite && <Star aria-label="Favorite" role="img" size={14} strokeWidth={1.5} fill="currentColor" />}
 <Button variant="ghost" type="button" className="capture-card-note" disabled={selectable} aria-label={item.hasNote ? "Open private note" : "Add private note"} title="Private note" onClick={() => onOpen?.(item, true)}><Bookmark aria-hidden="true" size={14} strokeWidth={1.5} fill={item.hasNote ? "currentColor" : "none"} /></Button>
 <time>{shortDate(item.source === "web" ? item.savedAt : item.postedAt)}</time>
 {markShown && <span className="capture-card-source"><SourceMark source={item.source} faviconUrl={favicon ? mediaUrl(favicon) : undefined} size={14} /></span>}
 <CardShelfMenu itemId={item.id} title={item.title ?? item.authorName ?? item.author ?? "this save"} disabled={selectable} />
 </span>
 </footer>;
}

/** Room kept for the "+n" control when some chips do not fit (24px wide plus its 4px gap). */
const MORE_SPACE = 36;

export function CardOrganization({ item, tags, onChanged }: { item: ItemRow; tags: NonNullable<ItemRow["tags"]>; onChanged: () => void }) {
	const labels = tags.map((tag) => tag.label);
	const row = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number | null>(null);
	const key = labels.join("\u0000");

	// Measure the chips at their natural width and keep as many whole ones as fit.
	useLayoutEffect(() => {
		const node = row.current;
		if (!node || labels.length === 0) return;
		const measure = () => {
			const chips = [...node.querySelectorAll<HTMLElement>("[data-chip]")];
			const add = node.querySelector<HTMLElement>(".anansi-tag-add");
			const gap = 4;
			let room = node.clientWidth - (add ? add.offsetWidth + gap : 0);
			let shown = 0;
			for (const [index, chip] of chips.entries()) {
				const width = chip.offsetWidth + (shown > 0 ? gap : 0);
				const reserve = index < chips.length - 1 ? MORE_SPACE : 0;
				if (width + reserve > room) break;
				room -= width;
				shown += 1;
			}
			setFit(shown);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	const shown = fit ?? labels.length;
	return (
		<div ref={row} className="anansi-card-org" data-empty={labels.length === 0 || undefined}>
			<TagPopover itemId={item.id} current={labels} onChanged={onChanged} iconOnly={false} compactLabel={labels.length > 0} />
			{labels.map((label, index) => (
				<span key={label} data-chip className="anansi-tag-slot" data-hidden={index >= shown || undefined}>
					<TagChip label={label} />
				</span>
			))}
			<TagOverflow labels={labels.slice(shown)} />
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
function MediaGrid({ media, dim, inset, vertical, topCrop }: { vertical?: boolean; topCrop?: boolean; media: CardMedia[]; dim?: boolean; inset?: boolean }) {
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
            aspectRatio: vertical ? "3 / 4" : single ? "16 / 10" : "1 / 1",
            gridColumn: shown.length === 3 && i === 0 ? "span 2" : undefined,
          }}
        >
          <img
            src={mediaUrl(m.key)}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: vertical || topCrop ? "center top" : undefined, display: "block" }}
          />
          {m.kind === "video_poster" && (
            <span aria-label="Video" style={{ position: "absolute", ...(vertical ? { right: 8, bottom: 8 } : { inset: 0 }), display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: vertical ? 26 : 34, height: vertical ? 26 : 34, borderRadius: "50%", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--text)"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </span>
          )}
        </div>
      ))}
      {media.length > 4 && (
        <span
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            fontSize: "var(--text-body)",
            padding: "2px 6px",
            borderRadius: 3,
            background: "#0b0e11cc",
            color: "#fff",
          }}
        >
          +{media.length - 4}<span className="sr-only"> more images</span>
        </span>
      )}
    </div>
  );
}
