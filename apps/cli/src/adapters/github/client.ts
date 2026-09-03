/**
 * GitHub, for contrast.
 *
 * Everything X made hard, this makes easy: a documented endpoint, a real
 * pagination scheme, a token designed for the job, and — the part that
 * matters most downstream — an actual `starred_at` timestamp.
 *
 * The token here is nothing like the X cookies. A fine-grained PAT is
 * purpose-scoped, revocable from a settings page, carries no session, and is
 * the officially documented way in. Asking for one is reasonable; asking for
 * an auth_token is not.
 */

const API = "https://api.github.com";

export interface GithubAuth {
  token: string;
}

export function githubAuth(): GithubAuth {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Missing GITHUB_TOKEN.\n" +
        "  Create a fine-grained token with read-only access to your starred\n" +
        "  repositories at https://github.com/settings/personal-access-tokens\n" +
        "  then put it in .env as GITHUB_TOKEN=...",
    );
  }
  return { token };
}

function headers(auth: GithubAuth, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${auth.token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "anansi",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(url: string, auth: GithubAuth, accept: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: headers(auth, accept) });
    if (res.ok || res.status === 404) return res;

    // GitHub signals a primary rate limit with remaining: 0 and a reset time,
    // and a secondary one with retry-after. Honour whichever it sent.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const limited = res.status === 429 || (res.status === 403 && remaining === "0");

    if (!limited || attempt >= 3) {
      throw new Error(
        `github ${res.status} ${res.statusText} for ${url}` +
          (res.status === 401 ? "\n  GITHUB_TOKEN is invalid or expired." : ""),
      );
    }

    const waitMs = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Number.isFinite(reset)
        ? Math.max(reset * 1000 - Date.now(), 0) + 1000
        : 2 ** attempt * 1000;
    console.warn(`  ! github rate limited; waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(Math.min(waitMs, 5 * 60_000));
  }
}

/**
 * `application/vnd.github.star+json` is the whole reason this source is worth
 * having early: without it the response is a bare repo list, with it every
 * entry carries `starred_at`. That is the first exact saved-at in the
 * library, and the only thing currently exercising saved_at_exact.
 */
export async function fetchStarredPage(
  auth: GithubAuth,
  page: number,
  perPage = 100,
): Promise<{ body: unknown[]; hasMore: boolean }> {
  const res = await request(
    `${API}/user/starred?per_page=${perPage}&page=${page}`,
    auth,
    "application/vnd.github.star+json",
  );
  const body = (await res.json()) as unknown[];
  // Link rel="next" is authoritative; length is the fallback when it is absent.
  const link = res.headers.get("link") ?? "";
  const hasMore = link.includes('rel="next"') || body.length === perPage;
  return { body, hasMore };
}

/** Missing READMEs are normal, not an error. */
export async function fetchReadme(
  auth: GithubAuth,
  fullName: string,
  maxChars: number,
): Promise<string | undefined> {
  try {
    const res = await request(
      `${API}/repos/${fullName}/readme`,
      auth,
      "application/vnd.github.raw",
    );
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.slice(0, maxChars);
  } catch {
    return undefined;
  }
}
