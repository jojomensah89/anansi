import type { CaptureAdapter, CaptureOptions, CapturePage, ParseContext } from "../types.ts";
import type { NormalizedItem } from "@anansi/sources";
import { parseSavedListing, savedListingCursor } from "@anansi/sources/reddit";

/**
 * Reddit saved posts and comments.
 *
 * Sits between the other two in difficulty. GitHub has a documented API and a
 * scoped token; X has neither and needs the browser. Reddit has a documented
 * JSON endpoint that answers to a normal logged-in session, so the browser
 * path works without any app registration, OAuth dance, or client secret —
 * which is the same reason the extension is the right home for it.
 *
 * The CLI adapter exists for the headless path and for parsing payloads
 * already on disk. Capture for anyone but you belongs in the extension.
 */
export interface RedditAdapterOptions {
  /** Reddit needs the username in the path; `me` works with a session. */
  username?: string;
  perPage?: number;
  /** Cookie header for the headless path. Absent means parse-only. */
  cookie?: string;
}

export function createRedditAdapter(opts: RedditAdapterOptions = {}): CaptureAdapter {
  const perPage = opts.perPage ?? 100;
  const username = opts.username ?? "me";

  return {
    source: "reddit",

    async *pages(options: CaptureOptions): AsyncIterable<CapturePage> {
      if (!opts.cookie) {
        throw new Error(
          "Reddit capture runs in the browser, where your session already is. " +
            "Use the extension, or pass a cookie for the headless path.",
        );
      }

      let after: string | null = options.cursor ?? null;
      let page = 0;

      for (;;) {
        const url =
          `https://www.reddit.com/user/${username}/saved.json` +
          `?limit=${perPage}&raw_json=1${after ? `&after=${after}` : ""}`;

        const res = await fetch(url, {
          headers: {
            cookie: opts.cookie,
            // Reddit rate-limits generic agents hard and asks for a real one.
            "user-agent": "anansi/0.1 (personal library importer)",
            accept: "application/json",
          },
        });
        if (!res.ok) throw new Error(`reddit ${res.status} ${res.statusText}`);

        const raw = await res.json();
        page++;
        const next = savedListingCursor(raw);
        yield { raw, cursor: next, page };

        const ids = parseSavedListing(raw, { importedAt: 0 }).map((i) => i.externalId);
        if (ids.length === 0) return;
        if (options.stopAt?.(ids)) return;
        if (options.maxPages && page >= options.maxPages) return;
        if (!next) return;
        after = next;
      }
    },

    parse(raw: unknown, ctx: ParseContext): NormalizedItem[] {
      return parseSavedListing(raw, ctx);
    },
  };
}
