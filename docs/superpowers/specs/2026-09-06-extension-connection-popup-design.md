# Extension connection and popup UX

## Problem

Anansi currently asks the owner to paste an API origin and `INGEST_TOKEN` into the extension popup after building and loading the extension. This exposes deployment plumbing in a daily-use interface and makes a private, self-hosted installation feel unfinished.

The same `server` value is also used as both the API origin and the destination for **Open library**. In local development those are currently different ports: Vite serves the library on `127.0.0.1:3001`, while Bun serves the SQLite-backed API on `127.0.0.1:8788`. Consequently, **Open library** opens the API process rather than the web UI.

When the authenticated extension-config request fails, the popup sets its config to `null`. Its source-row construction then produces no rows, so an authentication or connectivity problem appears as though X, Reddit, TikTok, and GitHub do not exist. Ingest failures are also reduced to terse status text such as `HTTP 422`, which does not say what the server rejected.

## Product decision

Anansi is currently a private, owner-built extension for a personal deployment. Its connection settings will therefore be supplied at extension build time instead of entered in the popup.

This does not remove ingest authentication. The Worker must continue to reject unauthenticated writes because an open endpoint would let anyone who discovers the URL add content to the owner's library. The build embeds the owner's ingest credential into the private extension artifact. Anyone who receives that artifact can extract the credential, so a configured build must never be published or shared. A future publicly distributed extension will require a pairing or per-install credential flow; that is outside this change.

## Goals

- Configure the private extension once as part of the build/deployment workflow.
- Present one public Anansi origin for the library, API, and MCP endpoints.
- Make **Open library** open the web library.
- Keep all supported sources visible during connection and authentication failures.
- Explain actionable failures without exposing credentials.
- Preserve immediate delivery, durable retry, resumable imports, and source kill switches.
- Replace interval selection with a fixed daily catch-up schedule.
- Document local and Cloudflare setup as complete step-by-step paths.

## Non-goals

- Public Chrome Web Store distribution.
- Multi-user or per-device token issuance.
- Removing bearer authentication from extension endpoints.
- Changing library-session or MCP authentication.
- Combining the Vite and Bun development processes into one runtime.
- Claiming Cloudflare deployment or authenticated provider acceptance without performing it.

## Connection model

The extension build accepts two private inputs:

- `ANANSI_EXTENSION_ORIGIN`: the public origin that serves the Anansi library.
- `ANANSI_EXTENSION_INGEST_TOKEN`: the bearer credential accepted by extension endpoints.

These names deliberately avoid `VITE_*` and other general web-client variables. The build mechanism may expose them only inside the extension bundle; they must not enter the web application's public client bundle, generated documentation, logs, or committed files.

The extension reads immutable build configuration through a small connection module shared by the popup and background worker. URL validation retains the existing rules: HTTPS is required except for loopback development, credentials in URLs are rejected, paths are removed, and the result is a canonical origin.

A build fails clearly when either required value is absent or invalid. It must not silently produce an extension that later asks the user to repair missing configuration in the popup.

The authorization boundaries remain independent:

- `LIBRARY_TOKEN` establishes the web library's HttpOnly session.
- `INGEST_TOKEN` authorizes extension config, stats, ingest, and heartbeat requests.
- `MCP_TOKEN` authorizes agent access to `/mcp`.

For a private build, `ANANSI_EXTENSION_INGEST_TOKEN` is populated from the same secret value deployed as `INGEST_TOKEN`; it is not a fourth server-side credential.

## One-origin topology

The owner configures one origin, never a separate API URL:

| Environment | Public origin | Library | API | MCP |
| --- | --- | --- | --- | --- |
| Local | `http://127.0.0.1:3001` | `/` | `/api/*` | `/mcp` |
| Cloudflare | `https://<worker>.workers.dev` | `/` | `/api/*` | `/mcp` |

Cloudflare already serves the website Worker and its routes from one origin.

Local development retains two internal processes because Vite's Node runtime cannot load the SQLite implementation used by Bun. Vite proxies `/api/*` and `/mcp` to the internal Bun server at `http://127.0.0.1:8788`, preserving methods, bodies, authorization headers, cookies, and response status. The internal port remains visible in developer diagnostics only. The launcher and README advertise `3001` as the only origin used by the browser, extension, and human.

The web application uses same-origin `/api/*` requests in both environments. Local CORS remains narrow as defence in depth for direct internal-port access, but the normal path no longer depends on cross-origin requests.

## Popup design

The settings gear, server input, ingest-token input, interval selector, and Save button are removed.

The popup keeps:

- library item count and connection state;
- durable outbox summary and retry action;
- one row each for X, Reddit, TikTok, and GitHub;
- current-page capture;
- optional Chrome bookmark mirroring;
- **Open library**;
- redacted diagnostics.

**Open library** resolves `/` against `ANANSI_EXTENSION_ORIGIN`. It never opens the ingest endpoint or the internal local API port.

Source rows come from a static supported-source catalogue augmented by remote config. Remote config controls operational details, feature flags, and server-side kill switches, but failure to fetch it cannot erase the known rows. Before config is available, every row renders a neutral connection state and disables actions that require server instructions. Once config succeeds, disabled sources say that they are off rather than disappearing.

The connection summary distinguishes:

- unreachable server or timeout;
- `401`/`403` credential mismatch;
- incompatible or older server (`404` or invalid config shape);
- connected server with source-specific state.

No diagnostic may display the bearer token, authorization header, query credentials, or unredacted request bodies.

## Automatic catch-up

Live observed saves and durable outbox delivery continue immediately. The scheduled job has a different purpose: it catches provider changes made while the extension was stopped, Chrome was closed, a content script was not present, or delivery was interrupted.

The user-facing interval setting is removed. A configured extension schedules catch-up once every 24 hours. The existing alarm runs only remote-configured sources whose mode supports a history import. Imports remain incremental, idempotent, resumable, and subject to source kill switches. Manual **Import**, **Retry**, and **Pause** actions remain available where applicable.

TikTok remains observation-based and is not turned into a forged background importer. If a scheduled source requires a signed-in page context, existing tab/session rules still apply and the popup must accurately report a sign-in requirement.

## Error handling

Connection requests retain bounded timeouts and redirect rejection. The popup records a structured, redacted connection error rather than treating every failure as `null` data.

Ingest transport extracts a bounded server error message or error code from JSON responses when available. A `422` therefore reports a safe reason such as an unsupported payload version or invalid capture shape. If the response is non-JSON or contains unsafe detail, the fallback remains the HTTP status. Durable queue state is unchanged, so rejected captures remain inspectable/retryable according to existing retry policy.

A credential mismatch instructs the owner to rebuild the extension and confirm that its build token matches the deployed `INGEST_TOKEN`; the popup does not offer an emergency token field.

## Documentation

The README will provide two independent paths.

### Local

1. Install dependencies.
2. create `.env` from `.env.example`;
3. set independent `LIBRARY_TOKEN`, `INGEST_TOKEN`, and `MCP_TOKEN` values;
4. set the extension build origin to `http://127.0.0.1:3001` and its build token to the same value as `INGEST_TOKEN`;
5. start the stack with the one-command local launcher;
6. build the extension;
7. load `apps/extension/.output/chrome-mv3` from `chrome://extensions`;
8. open the popup, confirm connection, and use the printed `LIBRARY_TOKEN` to sign into the library;
9. sign into each provider in the same Chrome profile before its first import.

The instructions explain that `8788` is an internal development port and should not be entered anywhere.

### Cloudflare

1. Authenticate Alchemy/Cloudflare with the least-privilege deployment credential;
2. configure `LIBRARY_TOKEN`, `INGEST_TOKEN`, and `MCP_TOKEN` as deployment secrets;
3. deploy the Worker, D1 database, R2 bucket, and migrations;
4. copy the resulting Worker origin into `ANANSI_EXTENSION_ORIGIN`;
5. build the private extension using the same value for `ANANSI_EXTENSION_INGEST_TOKEN` as the deployed `INGEST_TOKEN`;
6. load the private extension and verify its connection;
7. sign into the library and provider sites;
8. perform first-import and search acceptance checks.

Until a clean-account Cloudflare deployment has actually passed, the README must label those steps as intended/unverified rather than confirmed instructions.

## Verification

Automated checks cover:

- canonical build-origin validation;
- missing/invalid build configuration failure;
- background and popup use of the same immutable connection values;
- all source rows rendering when config is loading, unreachable, or unauthorized;
- disabled remote sources remaining visible and marked off;
- **Open library** targeting the public origin root;
- fixed daily alarm scheduling and resumable/manual actions;
- local `/api/*` and `/mcp` proxy behavior, including bearer headers and error statuses;
- safe extraction and redaction of structured `422` errors;
- existing queue, source-run, config-cache, ingest, heartbeat, and popup-state regressions;
- extension compile/build, web build, repository tests, typecheck, React Doctor, and `git diff --check`.

Manual local acceptance covers:

1. start `bun run dev:local` and interact only with `http://127.0.0.1:3001`;
2. confirm `/`, `/api/auth/session`, and `/mcp` are reachable through that origin as appropriate;
3. load a newly built extension without entering settings;
4. confirm all four provider rows are visible;
5. confirm **Open library** opens the web UI;
6. verify an intentional token mismatch produces a clear auth error without revealing either token;
7. restore the matching token and verify config, stats, heartbeat, and one ordinary page capture;
8. verify the X `422` path shows the server's safe rejection reason, then separately diagnose and accept the X payload against a signed-in session;
9. verify provider imports only while signed into those providers.

Cloudflare acceptance remains a separate release gate: clean-account deployment, migration, extension connection, authenticated provider capture, library search, MCP access, and export/restore must all be demonstrated against the deployed origin before the hosted path is described as verified.

## Acceptance criteria

- A correctly configured private extension connects immediately after being loaded; the popup has no server, token, interval, or Save controls.
- The ingest endpoint remains closed without the correct bearer credential.
- Local and hosted owners configure exactly one public origin.
- **Open library** always opens that origin's web UI.
- X, Reddit, TikTok, and GitHub remain visible through loading and failure states.
- A token mismatch is distinguishable from an unreachable or incompatible server.
- Safe server validation details make an ingest `422` actionable.
- Live capture remains immediate and catch-up runs daily without a user-facing frequency selector.
- Existing queue durability, retry, resume, kill-switch, and secret-redaction properties remain intact.
- README instructions match the implemented local workflow and accurately label unverified hosted behavior.
