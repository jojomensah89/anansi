/**
 * The contract every adapter produces and every consumer reads.
 *
 * These field names mirror the `items` table in the build spec one-for-one,
 * so day 2 is a mapping and not a redesign. Anything a source knows that
 * doesn't fit here survives in `raw`.
 */

export type Source = "x" | "github" | "reddit" | "tiktok";
export type Kind = "post" | "repo";

export interface MediaRef {
  kind: "image" | "video_poster" | "card";
  originUrl: string;
  width?: number;
  height?: number;
}

export interface NormalizedItem {
  source: Source;
  /** Tweet id or repo node id. Unique with `source`; this is the upsert key. */
  externalId: string;
  url: string;
  kind: Kind;
  authorHandle?: string;
  authorName?: string;
  authorAvatar?: string;
  title?: string;
  /** full_text, or repo description + README head. */
  body: string;
  lang?: string;
  /** Unix seconds. SQLite has no date type and neither do we. */
  postedAt?: number;
  /**
   * Unix seconds. See the note in adapters/x/parse.ts: the bookmarks
   * timeline does NOT return a per-item saved-at, so backfill stamps
   * import time and records the real ordering key in `raw.sortIndex`.
   */
  savedAt: number;
  savedAtIsExact: boolean;
  /** The source timeline's ordering key, where it has one. */
  saveOrder?: number;
  metrics: Record<string, number>;
  media: MediaRef[];
  links: string[];
  raw: unknown;
}

export function itemKey(item: Pick<NormalizedItem, "source" | "externalId">): string {
  return `${item.source}:${item.externalId}`;
}
