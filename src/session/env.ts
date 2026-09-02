import type { SessionProvider, XSession } from "./types.ts";
import { resolveEndpoint } from "../adapters/x/endpoint.ts";

/**
 * Cookies from .env, pasted out of DevTools.
 *
 * Deliberately not a cookie-store reader on day 1. The build spec flags the
 * wrinkle and this machine is the case that hits it: Chrome's app-bound
 * encryption on Windows means reading the live cookie jar is a project of its
 * own, and finding that out on day 1 is exactly what the spec said to avoid.
 * Pasting two values takes ten seconds and unblocks everything downstream.
 */

export function envCookies(): { authToken: string; csrf: string } | undefined {
  const authToken = process.env.X_AUTH_TOKEN?.trim();
  const csrf = process.env.X_CSRF_TOKEN?.trim();
  return authToken && csrf ? { authToken, csrf } : undefined;
}

export const envSession: SessionProvider = {
  name: "env",
  async get(): Promise<XSession> {
    const cookies = envCookies();
    if (!cookies) {
      throw new Error(
        "Missing X_AUTH_TOKEN or X_CSRF_TOKEN.\n" +
          "  Copy .env.example to .env, then from a logged-in x.com tab:\n" +
          "  DevTools > Application > Cookies > https://x.com\n" +
          "    auth_token -> X_AUTH_TOKEN\n" +
          "    ct0        -> X_CSRF_TOKEN",
      );
    }

    // The cookies go to the resolver too: without them the scan only ever
    // sees the logged-out shell, which never references Bookmarks.
    const { bearer } = await resolveEndpoint({ cookies });
    return { ...cookies, bearer };
  },
};
