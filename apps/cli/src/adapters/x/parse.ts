import type { MediaRef, NormalizedItem } from "../../core/item.ts";
import type { ParseContext } from "../types.ts";

/**
 * Raw bookmark payload -> NormalizedItem[].
 *
 * Pure, and deliberately so: it runs over payloads already on disk, which is
 * what makes `anansi reparse` free and lets the five shapes that break naive
 * normalizers (retweet, quote, thread reply, four images, video) be developed
 * against real fixtures instead of guesses.
 *
 * Everything here tolerates missing fields. A payload shape that changed
 * should cost you one item and a warning, never the run.
 */

type Any = Record<string, any>;

export interface ParseResult {
  items: NormalizedItem[];
  cursor: string | null;
  /** Entries that looked like tweets but yielded nothing — tombstones etc. */
  skipped: number;
}

function instructionsOf(raw: unknown): Any[] {
  const root = raw as Any;
  const timeline =
    root?.data?.bookmark_timeline_v2?.timeline ??
    root?.data?.bookmark_timeline?.timeline ??
    root?.data?.bookmarkTimeline?.timeline;
  return (timeline?.instructions as Any[] | undefined) ?? [];
}

function entriesOf(raw: unknown): Any[] {
  for (const instruction of instructionsOf(raw)) {
    if (Array.isArray(instruction.entries)) return instruction.entries as Any[];
  }
  return [];
}

/**
 * Unwrap the two wrappers X puts around a tweet. `TweetWithVisibilityResults`
 * nests the real object one level down under `.tweet`; miss it and those
 * items vanish silently, which is exactly the spec's warning.
 */
function unwrap(result: Any | undefined): Any | undefined {
  if (!result) return undefined;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
  if (result.tweet && !result.legacy) return result.tweet;
  return result;
}

function userOf(tweet: Any): { handle?: string; name?: string } {
  const user = unwrapUser(tweet?.core?.user_results?.result);
  if (!user) return {};
  // X is mid-migration: newer payloads put these on `core`, older on `legacy`.
  return {
    handle: user.core?.screen_name ?? user.legacy?.screen_name,
    name: user.core?.name ?? user.legacy?.name,
  };
}

function unwrapUser(user: Any | undefined): Any | undefined {
  if (!user) return undefined;
  return user.__typename === "UserUnavailable" ? undefined : user;
}

/**
 * X rewrites every link in the text as a t.co shortener and ships the real
 * target in an entity. A body full of `https://t.co/COLryoAtwK` is useless to
 * the agent that is supposed to answer questions from it, so the text gets
 * the expanded URL substituted back in.
 *
 * Media links are a special case: X appends a t.co pointing at the photo or
 * video, which is already captured as a MediaRef. Those are dropped rather
 * than expanded — the text should not end in a bare pic URL.
 */
function urlEntitiesOf(tweet: Any): { expand: Map<string, string>; drop: Set<string> } {
  const expand = new Map<string, string>();
  const drop = new Set<string>();

  const urlSets: Any[][] = [
    tweet?.legacy?.entities?.urls ?? [],
    tweet?.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? [],
  ];
  for (const set of urlSets) {
    for (const u of set) {
      if (typeof u?.url === "string" && typeof u?.expanded_url === "string") {
        expand.set(u.url, u.expanded_url);
      }
    }
  }

  const mediaSets: Any[][] = [
    tweet?.legacy?.entities?.media ?? [],
    tweet?.legacy?.extended_entities?.media ?? [],
  ];
  for (const set of mediaSets) {
    for (const m of set) if (typeof m?.url === "string") drop.add(m.url);
  }

  return { expand, drop };
}

function expandUrls(text: string, tweet: Any): string {
  const { expand, drop } = urlEntitiesOf(tweet);
  if (expand.size === 0 && drop.size === 0) return text;

  let out = text;
  for (const url of drop) out = out.split(url).join("");
  for (const [short, full] of expand) {
    if (!drop.has(short)) out = out.split(short).join(full);
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** Long posts carry their real text on note_tweet; full_text is truncated. */
function textOf(tweet: Any): string {
  const note = tweet?.note_tweet?.note_tweet_results?.result?.text;
  const raw =
    typeof note === "string" && note.length > 0
      ? note
      : typeof tweet?.legacy?.full_text === "string"
        ? tweet.legacy.full_text
        : "";
  return expandUrls(raw, tweet);
}

function mediaOf(tweet: Any): MediaRef[] {
  const list: Any[] =
    tweet?.legacy?.extended_entities?.media ?? tweet?.legacy?.entities?.media ?? [];
  return list.map((m): MediaRef => {
    const size = m?.original_info ?? {};
    return {
      // Videos and gifs are stored as their poster frame. Rehosting MP4s is
      // the one line in the cost section that could actually start a bill.
      kind: m?.type === "photo" ? "image" : "video_poster",
      originUrl: m?.media_url_https ?? m?.media_url ?? "",
      width: typeof size.width === "number" ? size.width : undefined,
      height: typeof size.height === "number" ? size.height : undefined,
    };
  });
}

function linksOf(tweet: Any): string[] {
  const urls: Any[] = tweet?.legacy?.entities?.urls ?? [];
  return [
    ...new Set(
      urls
        .map((u) => u?.expanded_url)
        .filter((u): u is string => typeof u === "string" && !u.includes("//x.com/i/web/")),
    ),
  ];
}

function metricsOf(tweet: Any): Record<string, number> {
  const legacy = tweet?.legacy ?? {};
  const metrics: Record<string, number> = {
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    replies: legacy.reply_count ?? 0,
    quotes: legacy.quote_count ?? 0,
    bookmarks: legacy.bookmark_count ?? 0,
  };
  const views = Number(tweet?.views?.count);
  if (Number.isFinite(views)) metrics.views = views;
  return metrics;
}

function postedAtOf(tweet: Any): number | undefined {
  const created = tweet?.legacy?.created_at;
  if (typeof created !== "string") return undefined;
  const ms = Date.parse(created);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function normalizeTweet(
  outer: Any,
  sortIndex: string | undefined,
  ctx: ParseContext,
): NormalizedItem | undefined {
  const tweet = unwrap(outer);
  if (!tweet || tweet.__typename === "TweetTombstone") return undefined;

  const externalId: string | undefined = tweet.rest_id ?? tweet.legacy?.id_str;
  if (!externalId) return undefined;

  // A bookmarked retweet is a pointer: the content worth indexing, and the
  // author worth remembering, both belong to the post being retweeted.
  const retweeted = unwrap(tweet.legacy?.retweeted_status_result?.result);
  const subject = retweeted ?? tweet;

  const author = userOf(subject);
  const quoted = unwrap(tweet.quoted_status_result?.result);
  const quotedAuthor = quoted ? userOf(quoted) : undefined;

  let body = textOf(subject);
  if (quoted) {
    // Folded into body on purpose: the quote is usually the half of a
    // quote-tweet you actually remember, and body is what FTS5 indexes.
    body = `${body}\n\n— quoting @${quotedAuthor?.handle ?? "unknown"}: ${textOf(quoted)}`.trim();
  }

  const links = [...new Set([...linksOf(subject), ...(quoted ? linksOf(quoted) : [])])];
  const subjectId = subject.rest_id ?? subject.legacy?.id_str ?? externalId;

  return {
    source: "x",
    externalId,
    url: `https://x.com/${author.handle ?? "i"}/status/${subjectId}`,
    kind: "post",
    authorHandle: author.handle,
    authorName: author.name,
    body,
    lang: subject.legacy?.lang,
    postedAt: postedAtOf(subject),
    // The bookmarks timeline carries no per-item saved-at. `sortIndex` is the
    // real ordering key and it is preserved in raw; this stamp is the import.
    savedAt: ctx.importedAt,
    savedAtIsExact: false,
    saveOrder: sortIndex ? Number(sortIndex) : undefined,
    metrics: metricsOf(subject),
    media: [...mediaOf(subject), ...(quoted ? mediaOf(quoted) : [])],
    links,
    raw: {
      sortIndex,
      isRetweet: !!retweeted,
      retweetedBy: retweeted ? userOf(tweet).handle : undefined,
      quotedId: quoted?.rest_id,
      inReplyToStatusId: tweet.legacy?.in_reply_to_status_id_str,
      conversationId: tweet.legacy?.conversation_id_str,
      tweet: outer,
    },
  };
}

export function parseBookmarksPage(raw: unknown, ctx: ParseContext): ParseResult {
  const items: NormalizedItem[] = [];
  let cursor: string | null = null;
  let skipped = 0;

  for (const entry of entriesOf(raw)) {
    const id: string = entry?.entryId ?? "";

    if (id.startsWith("cursor-bottom")) {
      cursor = entry?.content?.value ?? null;
      continue;
    }
    if (!id.startsWith("tweet-")) continue;

    const result = entry?.content?.itemContent?.tweet_results?.result;
    const item = normalizeTweet(result, entry?.sortIndex, ctx);
    if (item) items.push(item);
    else skipped++;
  }

  return { items, cursor, skipped };
}
