import type { NormalizedItem } from "../item.ts";
import type { ParseContext } from "../context.ts";

type Any = Record<string, any>;

/**
 * TikTok favourites -> NormalizedItem[].
 *
 * UNVERIFIED against a real payload. Written to the documented shape of the
 * `item_list` responses the web app makes, but nobody has run it on a real
 * favourites page yet, and TikTok reshapes these more freely than X does.
 *
 * That is survivable rather than reckless because of where it runs: the
 * extension uploads raw and the server parses, so a wrong guess here is a
 * server-side fix and not a reinstall. And /api/ingest returns 422 on a
 * payload that parses to zero, so being wrong shows up in the popup
 * immediately rather than as a library that quietly never grows.
 *
 * Capture is observe-only. TikTok publishes no favourites API and signs its
 * web requests, so there is no backfill to write — the extension watches what
 * the app itself fetches while you scroll.
 */
function unix(value: unknown): number | undefined {
  const n = Number(value);
  // createTime is seconds; a millisecond value here would be absurd.
  return Number.isFinite(n) && n > 1_000_000_000 && n < 4_000_000_000 ? Math.floor(n) : undefined;
}

export function parseItemList(raw: unknown, ctx: ParseContext): NormalizedItem[] {
  const root = raw as Any;
  const list: Any[] = root?.itemList ?? root?.items ?? [];
  const items: NormalizedItem[] = [];

  list.forEach((item, index) => {
    const id: string | undefined = item?.id;
    if (!id) return;

    const author: Any = item?.author ?? {};
    const handle: string | undefined = author.uniqueId;
    const stats: Any = item?.stats ?? item?.statsV2 ?? {};
    const cover: string | undefined =
      item?.video?.cover ?? item?.video?.originCover ?? item?.video?.dynamicCover;

    items.push({
      source: "tiktok",
      externalId: id,
      url: handle
        ? `https://www.tiktok.com/@${handle}/video/${id}`
        : `https://www.tiktok.com/video/${id}`,
      kind: "post",
      authorHandle: handle,
      authorName: author.nickname ?? handle,
      authorAvatar: author.avatarThumb ?? author.avatarMedium,
      body: String(item?.desc ?? ""),
      postedAt: unix(item?.createTime),
      savedAt: ctx.importedAt,
      savedAtIsExact: false,
      saveOrder: ctx.importedAt * 1000 - index,
      metrics: {
        likes: Number(stats.diggCount) || 0,
        comments: Number(stats.commentCount) || 0,
        shares: Number(stats.shareCount) || 0,
        plays: Number(stats.playCount) || 0,
      },
      // The video itself is never stored. The poster frame is the whole media
      // policy, and it is what keeps R2 inside the free tier.
      media: cover ? [{ kind: "video_poster", originUrl: cover }] : [],
      links: [],
      raw: {
        music: item?.music?.title ?? null,
        duration: item?.video?.duration ?? null,
        challenges: (item?.challenges ?? []).map((c: Any) => c?.title).filter(Boolean),
        item,
      },
    });
  });

  return items;
}
