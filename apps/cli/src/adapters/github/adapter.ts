import type { CaptureAdapter, CaptureOptions, CapturePage, ParseContext } from "../types.ts";
import type { NormalizedItem } from "../../core/item.ts";
import { fetchReadme, fetchStarredPage, githubAuth } from "./client.ts";
import { README_CHARS, parseStarredPage } from "./parse.ts";
import type { StarredRawPage } from "./parse.ts";

export interface GithubAdapterOptions {
  /** Parse-only construction, same as the X adapter. */
  authenticated?: boolean;
  perPage?: number;
  /** README fetching is one extra request per repo; skippable. */
  readmes?: boolean;
}

export function createGithubAdapter(opts: GithubAdapterOptions = {}): CaptureAdapter {
  const perPage = opts.perPage ?? 100;
  const wantReadmes = opts.readmes ?? true;

  return {
    source: "github",

    async *pages(options: CaptureOptions): AsyncIterable<CapturePage> {
      const auth = githubAuth();
      // GitHub pages by number, X by opaque cursor. The interface carries a
      // cursor either way, so this stores the page number in it — and the
      // resume path works without core/ knowing the difference.
      let page = options.cursor ? Number(options.cursor) : 1;
      let fetched = 0;

      for (;;) {
        const { body, hasMore } = await fetchStarredPage(auth, page, perPage);
        if (body.length === 0) return;

        const raw: StarredRawPage = { starred: body };

        if (wantReadmes) {
          const readmes: Record<string, string> = {};
          for (const entry of body as Record<string, any>[]) {
            const fullName: string | undefined = (entry?.repo ?? entry)?.full_name;
            if (!fullName) continue;
            const text = await fetchReadme(auth, fullName, README_CHARS);
            if (text) readmes[fullName] = text;
          }
          raw.readmes = readmes;
        }

        fetched++;
        const next = hasMore ? String(page + 1) : null;
        yield { raw, cursor: next, page: fetched };

        const ids = parseStarredPage(raw, { importedAt: 0 }).map((i) => i.externalId);
        if (options.stopAt?.(ids)) return;
        if (options.maxPages && fetched >= options.maxPages) return;
        if (!hasMore) return;
        page++;
      }
    },

    parse(raw: unknown, ctx: ParseContext): NormalizedItem[] {
      return parseStarredPage(raw, ctx);
    },
  };
}
