import { readJson, writeJson } from "../../store/files.ts";

/**
 * Resolving the two moving parts of an X GraphQL call: the public bearer
 * token and the operation's queryId.
 *
 * The spec's whole "X didn't kill the API" finding rests on this. The queryId
 * is not in the main bundle; in a page you reach it through
 * `window.webpackChunk_twitter_responsive_web`. A CLI has no page, but the
 * bundles are public static assets, so the same string is reachable by
 * fetching and scanning them.
 *
 * One thing measured rather than assumed: fetching x.com without cookies
 * returns the *logged-out* shell, whose chunk graph is `LoggedOutShell` and
 * never references Bookmarks. The bearer is in there (verified), the queryId
 * is not and cannot be. So the scan takes the session's cookies when it has
 * them, and says plainly when it doesn't.
 *
 * Four tiers, most-trusted first. Whichever one answers is logged, because
 * silently falling back to a pinned hash is how you end up with an importer
 * that returns zero items and no explanation.
 */

export interface XEndpoint {
  bearer: string;
  bookmarksQueryId: string;
  source: "env" | "cache" | "network" | "pinned";
  resolvedAt: number;
}

export interface Cookies {
  authToken: string;
  csrf: string;
}

/** Verified live 2 Sep 2026. The floor, not the plan. */
const PINNED = {
  bearer:
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
  bookmarksQueryId: "iblrFnKr6PZUR-dWpfXG6g",
} as const;

const CACHE_FILE = "x-endpoint.json";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const BEARER_RE = /AAAAAAAA[A-Za-z0-9%\-_]{40,}/;
const SCRIPT_RE = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\\s)]+?\.js/g;

/** X emits both key orders depending on the chunk. Match either. */
function queryIdFor(operation: string, source: string): string | undefined {
  const a = source.match(new RegExp(`queryId:"([\w-]+)",operationName:"${operation}"`));
  if (a?.[1]) return a[1];
  const b = source.match(new RegExp(`operationName:"${operation}",queryId:"([\w-]+)"`));
  return b?.[1];
}

async function fetchText(url: string, cookies?: Cookies): Promise<string> {
  const headers: Record<string, string> = {
    "user-agent": UA,
    "accept-language": "en-US,en;q=0.9",
  };
  // Only ever to x.com. abs.twimg.com is a different origin serving public
  // static assets; it has no business seeing a session cookie.
  if (cookies && new URL(url).hostname.endsWith("x.com")) {
    headers.cookie = `auth_token=${cookies.authToken}; ct0=${cookies.csrf}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      out.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Scan x.com's shipped JavaScript for the bearer and the Bookmarks queryId.
 *
 * The shell only preloads its eager chunks and Bookmarks lives in a lazy one,
 * so this walks one level deeper, harvesting further chunk URLs out of the
 * bundles it already fetched. Capped, because "scan every asset Twitter
 * ships" is not a thing to do on every import.
 */
async function resolveFromNetwork(
  cookies?: Cookies,
): Promise<{ bearer?: string; bookmarksQueryId?: string; loggedIn: boolean }> {
  const seen = new Set<string>();
  let bearer: string | undefined;
  let bookmarksQueryId: string | undefined;

  const html = await fetchText("https://x.com/i/history", cookies);
  const loggedIn = !html.includes("LoggedOutShell");
  let frontier = [...new Set(html.match(SCRIPT_RE) ?? [])];

  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const batch = frontier.filter((u) => !seen.has(u)).slice(0, 80);
    batch.forEach((u) => seen.add(u));
    const next = new Set<string>();

    const sources = await mapLimit(batch, 8, async (url) => {
      try {
        return await fetchText(url);
      } catch {
        return "";
      }
    });

    for (const src of sources) {
      bearer ??= src.match(BEARER_RE)?.[0];
      bookmarksQueryId ??= queryIdFor("Bookmarks", src);
      for (const found of src.match(SCRIPT_RE) ?? []) next.add(found);
    }

    if (bearer && bookmarksQueryId) break;
    frontier = [...next];
  }

  return { bearer, bookmarksQueryId, loggedIn };
}

let cached: XEndpoint | undefined;

export interface ResolveOptions {
  refresh?: boolean;
  /** Without these the scan only ever sees the logged-out shell. */
  cookies?: Cookies;
}

export async function resolveEndpoint(opts: ResolveOptions = {}): Promise<XEndpoint> {
  if (cached && !opts.refresh) return cached;

  const envBearer = process.env.X_BEARER?.trim();
  const envQueryId = process.env.X_BOOKMARKS_QUERY_ID?.trim();
  if (envBearer && envQueryId) {
    cached = {
      bearer: envBearer,
      bookmarksQueryId: envQueryId,
      source: "env",
      resolvedAt: Date.now(),
    };
    return cached;
  }

  if (!opts.refresh) {
    const disk = await readJson<XEndpoint>(CACHE_FILE);
    if (disk && Date.now() - disk.resolvedAt < CACHE_TTL_MS) {
      cached = { ...disk, source: "cache" };
      return cached;
    }
  }

  let bearer: string | undefined;
  let bookmarksQueryId: string | undefined;
  let loggedIn = false;
  try {
    ({ bearer, bookmarksQueryId, loggedIn } = await resolveFromNetwork(opts.cookies));
  } catch (err) {
    console.warn(`  ! endpoint resolution failed: ${(err as Error).message}`);
  }

  const resolved: XEndpoint = {
    bearer: envBearer ?? bearer ?? PINNED.bearer,
    bookmarksQueryId: envQueryId ?? bookmarksQueryId ?? PINNED.bookmarksQueryId,
    source: bearer && bookmarksQueryId ? "network" : "pinned",
    resolvedAt: Date.now(),
  };

  if (resolved.source === "pinned") {
    console.warn(
      `  ! could not read the Bookmarks queryId out of x.com's bundles (shell: ${
        loggedIn ? "logged in" : "logged OUT"
      }); using the pinned value.\n` +
        (loggedIn
          ? "    The chunk graph changed shape. Run snippets/resolve.js in a logged-in\n" +
            "    x.com console and set X_BOOKMARKS_QUERY_ID in .env."
          : "    The logged-out shell never references Bookmarks. Set X_AUTH_TOKEN and\n" +
            "    X_CSRF_TOKEN in .env so the scan sees the logged-in chunk graph."),
    );
  } else {
    await writeJson(CACHE_FILE, resolved);
  }

  cached = resolved;
  return resolved;
}
