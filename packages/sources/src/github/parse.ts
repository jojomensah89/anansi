import type { NormalizedItem } from "../item.ts";
import type { ParseContext } from "../context.ts";

type Any = Record<string, any>;

/**
 * A starred repo becomes the same NormalizedItem a tweet does.
 *
 * This is the whole point of doing GitHub second: if one items table and one
 * normalized shape really are source-agnostic, then a new adapter is a parser
 * and nothing else changes. Nothing in core/, store/ or packages/db is
 * touched by this file existing.
 */

/** README bodies are for retrieval, not archival — the head is enough. */
export const README_CHARS = 2000;

export interface StarredRawPage {
  /** Exactly as GitHub returned it. */
  starred: unknown[];
  /** Fetched separately, keyed by full_name, so `starred` stays untouched. */
  readmes?: Record<string, string>;
}

function unix(iso: unknown): number | undefined {
  if (typeof iso !== "string") return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function parseStarredPage(raw: unknown, ctx: ParseContext): NormalizedItem[] {
  const page = raw as StarredRawPage | Any[] | null;
  // Tolerate a bare array: an older raw file, or a hand-made fixture.
  const entries = (Array.isArray(page) ? page : (page?.starred ?? [])) as Any[];
  const readmes: Record<string, string> = Array.isArray(page) ? {} : (page?.readmes ?? {});

  const items: NormalizedItem[] = [];

  for (const entry of entries) {
    // With the star+json accept header each entry is {starred_at, repo}.
    // Without it, the entry IS the repo. Handle both.
    const repo: Any | undefined = entry?.repo ?? entry;
    if (!repo?.node_id && !repo?.id) continue;

    const fullName: string = repo.full_name ?? "";
    const starredAt = unix(entry?.starred_at);
    const description: string = repo.description ?? "";
    const readme = readmes[fullName];

    items.push({
      source: "github",
      externalId: String(repo.node_id ?? repo.id),
      url: repo.html_url ?? `https://github.com/${fullName}`,
      kind: "repo",
      authorHandle: repo.owner?.login,
      authorName: repo.owner?.login,
      title: fullName || undefined,
      // Description first so BM25 weights the one-line summary above the
      // README's install instructions and badges.
      body: [description, readme].filter(Boolean).join("\n\n").trim(),
      lang: undefined,
      postedAt: unix(repo.pushed_at) ?? unix(repo.created_at),
      // The first exact saved-at in the library. X cannot produce one until
      // the extension watches CreateBookmark.
      savedAt: starredAt ?? ctx.importedAt,
      savedAtIsExact: starredAt !== undefined,
      saveOrder: starredAt,
      metrics: {
        stars: repo.stargazers_count ?? 0,
        forks: repo.forks_count ?? 0,
        openIssues: repo.open_issues_count ?? 0,
        watchers: repo.subscribers_count ?? repo.watchers_count ?? 0,
      },
      media: [],
      links: [repo.homepage, repo.html_url].filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      ),
      raw: {
        language: repo.language ?? null,
        topics: repo.topics ?? [],
        archived: repo.archived ?? false,
        starredAt: entry?.starred_at ?? null,
        hasReadme: readme !== undefined,
        repo,
      },
    });
  }

  return items;
}
