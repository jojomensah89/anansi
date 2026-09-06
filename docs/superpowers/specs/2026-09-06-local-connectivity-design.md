# Local development connectivity

## Problem

`bun run dev:local` prints the library URL as `http://127.0.0.1:3001` and permits that exact origin to call the API at `http://127.0.0.1:8788`. Vite currently starts without an explicit host and binds to `localhost`/IPv6 instead. Opening the URL Vite advertises gives the page an origin of `http://localhost:3001`, which the local API does not authorize, so the browser reports `Failed to fetch` even though both processes are healthy.

## Scope

This change fixes only the one-command local development path. It does not alter production API-base selection, Cloudflare deployment, Worker configuration, or secrets.

## Design

The local launcher will pass `--host 127.0.0.1` when it starts Vite. The UI will then listen on the same hostname that the launcher prints, while its configured API base remains `http://127.0.0.1:8788`. The existing exact-origin CORS rule will therefore match without widening access.

No application component, API contract, authentication rule, or database behavior changes. Startup and shutdown handling remain in `scripts/dev.ts`.

## Error handling

The existing preflight continues to reject occupied ports before either child starts. If Vite fails to bind, the launcher stops the API process through its existing child-exit handler.

## Verification

1. Start the stack with `bun run dev:local`.
2. Confirm both ports listen on IPv4 loopback.
3. Open `http://127.0.0.1:3001` and confirm the connection gate reaches the API rather than showing `Failed to fetch`.
4. Sign in with the printed library token and confirm the library loads.
5. Run the focused typecheck and `git diff --check`.

## Acceptance criteria

- The advertised local library URL is reachable.
- The session request succeeds from that page's exact origin.
- A valid local library token opens the existing library.
- No production or Cloudflare deployment files change as part of this fix.
