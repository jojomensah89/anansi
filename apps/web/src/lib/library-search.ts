/**
 * The library's filters, as a URL.
 *
 * Not for the address bar's sake: it is what lets anything else in the app
 * point at a view of the library. "View 1,274" on Sources and a source in the
 * rail are ordinary links, not buttons that reach into a component's state, and
 * a filtered library survives a reload and can be sent to someone.
 *
 * This lives beside the route rather than inside it because a URL schema is not
 * a component: it is the one part of the page that is input from outside, it
 * needs testing on its own, and a test importing the route file would drag JSX
 * into a plain TypeScript build.
 */

export const VIEWS = ["grid", "row", "timeline"] as const;
export type ViewMode = (typeof VIEWS)[number];

/** Exclusive by nature: "has media" and "no media" cannot both be true. */
const MEDIA_VALUES = ["any", "image", "video", "none"];

/**
 * Two values, not three.
 *
 * "Include everything" is the absence of the filter, the way it is for every
 * other field — a chip reading "at source is anything" would be a chip that
 * does nothing.
 */
const REMOVED_VALUES = ["exclude", "only"];

export interface LibrarySearch {
  source?: string[];
  author?: string[];
  type?: string[];
  tag?: string[];
  media?: string;
  archived?: boolean;
  /** "exclude" is only what is still saved; "only" is only what has gone. */
  removed?: string;
  view?: ViewMode;
}

/** Long enough for any real handle or tag, short enough not to reach the query. */
const MAX_VALUE = 120;

/**
 * A comma list, or an array, or nothing.
 *
 * Comma-joined rather than JSON-encoded because ?source=x,tiktok is a URL a
 * person can read and edit, and %5B%22x%22%5D is not. The splitting happens
 * here, where the schema knows which params are lists, rather than in the
 * router's parser, which would be guessing on behalf of every route.
 */
function asList(value: unknown): string[] | undefined {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const list = [
    ...new Set(
      parts
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.length <= MAX_VALUE),
    ),
  ];
  return list.length > 0 ? list : undefined;
}

/**
 * Anyone can type a URL, edit one, or paste one they were sent, so nothing
 * here is trusted: an unknown view or media value is dropped rather than
 * passed to the query.
 */
export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const media = typeof search.media === "string" ? search.media : undefined;
  return {
    source: asList(search.source),
    author: asList(search.author),
    type: asList(search.type),
    tag: asList(search.tag),
    media: media && MEDIA_VALUES.includes(media) ? media : undefined,
    removed:
      typeof search.removed === "string" && REMOVED_VALUES.includes(search.removed)
        ? search.removed
        : undefined,
    archived: search.archived === true || search.archived === "true" ? true : undefined,
    view: VIEWS.find((v) => v === search.view),
  };
}

const some = (value: string[] | undefined) =>
  value && value.length > 0 ? value : undefined;

export type LibraryFilters = Omit<LibrarySearch, "view">;

/** Absent rather than empty, so a cleared filter leaves no trace in the URL. */
export function toLibrarySearch(filters: LibraryFilters, view: ViewMode): LibrarySearch {
  return {
    source: some(filters.source),
    author: some(filters.author),
    type: some(filters.type),
    tag: some(filters.tag),
    media: filters.media,
    removed: filters.removed,
    archived: filters.archived ? true : undefined,
    // The default view is the absence of the param, so a plain "/" stays plain.
    view: view === "grid" ? undefined : view,
  };
}
