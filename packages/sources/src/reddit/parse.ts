import type { MediaRef, NormalizedItem } from "../item.ts";
import type { ParseContext } from "../context.ts";

type Any = Record<string, any>;

/**
 * Reddit saved items -> NormalizedItem[].
 *
 * A saved listing mixes two kinds: `t3` is a post, `t1` is a comment. They
 * read differently enough that forcing one template over both loses the thing
 * that makes each useful — a post has a title and a link out, a comment is a
 * fragment whose context is the thread it sits in.
 *
 * Reddit does not tell you when you saved something. The listing is ordered
 * newest-saved first and that is all you get, so `saveOrder` is derived from
 * position and `savedAtIsExact` is false. The upsert keeps the first ordering
 * key it ever saw, so a re-import does not renumber your history.
 */

export interface RedditListing {
  kind?: string;
  data?: { after?: string | null; children?: Any[] };
}

function unix(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Reddit uses these strings where a url would be, and they are not urls. */
const NON_URL_THUMBS = new Set(["self", "default", "nsfw", "spoiler", "image", ""]);

function mediaOf(post: Any): MediaRef[] {
  const media: MediaRef[] = [];

  const preview = post?.preview?.images?.[0]?.source;
  if (preview?.url) {
    media.push({
      kind: "image",
      // Reddit html-escapes preview urls in JSON responses.
      originUrl: String(preview.url).replace(/&amp;/g, "&"),
      width: typeof preview.width === "number" ? preview.width : undefined,
      height: typeof preview.height === "number" ? preview.height : undefined,
    });
  }

  const thumb = post?.thumbnail;
  if (typeof thumb === "string" && !NON_URL_THUMBS.has(thumb) && thumb.startsWith("http")) {
    if (!media.some((m) => m.originUrl === thumb)) {
      media.push({ kind: post?.is_video ? "video_poster" : "image", originUrl: thumb });
    }
  }

  return media;
}

export function parseSavedListing(raw: unknown, ctx: ParseContext): NormalizedItem[] {
  const listing = raw as RedditListing;
  const children = listing?.data?.children ?? [];
  const items: NormalizedItem[] = [];

  children.forEach((child, index) => {
    const kind: string = child?.kind ?? "";
    const d: Any = child?.data ?? {};
    // `name` is Reddit's fullname (t3_abc123) and is the stable identity.
    const externalId: string | undefined = d.name ?? (d.id ? `${kind}_${d.id}` : undefined);
    if (!externalId) return;

    const isComment = kind === "t1";
    const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : d.url;
    if (!permalink) return;

    // A comment's own title is its thread's; without it the item is an
    // orphaned fragment when it comes back from a search.
    const title = isComment ? (d.link_title ?? null) : (d.title ?? null);
    const body = isComment ? (d.body ?? "") : (d.selftext ?? "");

    // An external link post has no text at all, so the destination is the
    // only thing that says what it is.
    const outbound: string[] = [];
    if (!isComment && typeof d.url === "string" && !d.url.includes("reddit.com")) {
      outbound.push(d.url);
    }

    items.push({
      source: "reddit",
      externalId,
      url: permalink,
      kind: "post",
      authorHandle: d.author && d.author !== "[deleted]" ? d.author : undefined,
      authorName: d.author && d.author !== "[deleted]" ? d.author : undefined,
      title: title ?? undefined,
      body: [title, body].filter(Boolean).join("\n\n").trim(),
      postedAt: unix(d.created_utc),
      savedAt: ctx.importedAt,
      savedAtIsExact: false,
      // Position in a newest-first listing. Descending from the import stamp
      // keeps later imports above earlier ones without inventing a timestamp.
      saveOrder: ctx.importedAt * 1000 - index,
      metrics: {
        score: Number(d.score) || 0,
        comments: Number(d.num_comments) || 0,
        upvoteRatio: Math.round((Number(d.upvote_ratio) || 0) * 100),
      },
      media: isComment ? [] : mediaOf(d),
      links: outbound,
      raw: {
        kind,
        subreddit: d.subreddit ?? null,
        isComment,
        isSelf: d.is_self ?? null,
        over18: d.over_18 ?? false,
        linkPermalink: d.link_permalink ?? null,
        child,
      },
    });
  });

  return items;
}

/** The cursor for the next page, or null at the end of the listing. */
export function savedListingCursor(raw: unknown): string | null {
  return (raw as RedditListing)?.data?.after ?? null;
}
