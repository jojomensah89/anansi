import type { CaptureAdapter, CaptureOptions, CapturePage, ParseContext } from "../types.ts";
import type { NormalizedItem } from "../../core/item.ts";
import type { SessionProvider } from "../../session/types.ts";
import { graphql } from "./client.ts";
import { resolveEndpoint } from "./endpoint.ts";
import { parseBookmarksPage } from "./parse.ts";

export interface XAdapterOptions {
  /**
   * Only needed by `pages()`. The parse-only paths — reparse, and the
   * ingest server handling payloads the browser captured — construct the
   * adapter without one, and must never be made to invent a credential.
   */
  session?: SessionProvider;
  /** 100 is what the timeline serves; the spike's 1,273 came back in 14 pages. */
  pageSize?: number;
}

export function createXAdapter(opts: XAdapterOptions): CaptureAdapter {
  const pageSize = opts.pageSize ?? 100;

  return {
    source: "x",

    async *pages(options: CaptureOptions): AsyncIterable<CapturePage> {
      if (!opts.session) {
        throw new Error(
          "This adapter was built without a session, so it can only parse. " +
            "Capture runs in the browser: `anansi ingest`.",
        );
      }
      const session = await opts.session.get();
      const { bookmarksQueryId } = await resolveEndpoint({
        cookies: { authToken: session.authToken, csrf: session.csrf },
      });

      let cursor = options.cursor ?? null;
      let page = 0;

      for (;;) {
        const variables: Record<string, unknown> = {
          count: pageSize,
          includePromotedContent: false,
          ...(cursor ? { cursor } : {}),
        };

        const { raw } = await graphql(session, bookmarksQueryId, "Bookmarks", variables);
        page++;

        const parsed = parseBookmarksPage(raw, { importedAt: Math.floor(Date.now() / 1000) });
        yield { raw, cursor: parsed.cursor, page };

        // Two ways a timeline ends: it stops returning items, or it stops
        // moving the cursor. Both happen in practice; check both.
        if (parsed.items.length === 0) return;
        if (!parsed.cursor || parsed.cursor === cursor) return;
        if (options.stopAt?.(parsed.items.map((i) => i.externalId))) return;
        if (options.maxPages && page >= options.maxPages) return;

        cursor = parsed.cursor;
      }
    },

    parse(raw: unknown, ctx: ParseContext): NormalizedItem[] {
      return parseBookmarksPage(raw, ctx).items;
    },
  };
}
