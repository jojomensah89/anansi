import type { XSession } from "../../session/types.ts";

export interface GraphqlPage {
  raw: unknown;
  status: number;
}

export interface BackoffOptions {
  maxRetries?: number;
  /** Never sleep longer than this on a rate-limit reset, in ms. */
  maxSleepMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated GraphQL call, with the retry behaviour the spec asks for.
 *
 * The spike ran 14 pages in 17.6s and hit no rate limiting, so this is a
 * seatbelt rather than a hot path — but a 429 that isn't handled looks
 * exactly like "X killed the API", which is the failure this project exists
 * to not repeat. `x-rate-limit-reset` is honoured when X sends it.
 */
export async function graphql(
  session: XSession,
  queryId: string,
  operation: string,
  variables: Record<string, unknown>,
  opts: BackoffOptions = {},
): Promise<GraphqlPage> {
  const maxRetries = opts.maxRetries ?? 5;
  const maxSleepMs = opts.maxSleepMs ?? 5 * 60_000;

  const url =
    `https://x.com/i/api/graphql/${queryId}/${operation}` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent("{}")}`;

  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${session.bearer}`,
        "x-csrf-token": session.csrf,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "en",
        "content-type": "application/json",
        cookie: `auth_token=${session.authToken}; ct0=${session.csrf}`,
      },
    });

    if (res.ok) return { raw: await res.json(), status: res.status };

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `x graphql ${operation} failed: ${res.status} ${res.statusText}` +
          (res.status === 401 || res.status === 403
            ? "\n  Your session is probably stale. Refresh auth_token and ct0 in .env."
            : "") +
          (body ? `\n  ${body.slice(0, 400)}` : ""),
      );
    }

    const reset = Number(res.headers.get("x-rate-limit-reset"));
    const untilReset = Number.isFinite(reset) ? reset * 1000 - Date.now() : NaN;
    const backoff = Math.min(
      Number.isFinite(untilReset) && untilReset > 0 ? untilReset + 1_000 : 2 ** attempt * 1_000,
      maxSleepMs,
    );

    attempt++;
    console.warn(
      `  ! ${res.status} on ${operation}; retry ${attempt}/${maxRetries} in ${Math.round(backoff / 1000)}s`,
    );
    await sleep(backoff);
  }
}
