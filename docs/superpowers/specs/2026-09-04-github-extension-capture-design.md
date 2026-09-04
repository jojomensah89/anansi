# GitHub extension capture design

## Goal

Capture GitHub starred repositories through the Anansi browser extension using
the GitHub session already present in the browser. The user does not connect a
GitHub account to Anansi, create OAuth credentials, or provide a personal
access token. Enabling GitHub starts one automatic history import; later star
and unstar actions are captured as they happen.

This design complements the existing
`2026-09-04-github-repo-card-design.md`. The repository-card and Mosaic-removal
work already present in the working tree is completed, verified, and committed
as a separate prerequisite before capture implementation begins.

## Product contract

- GitHub is a supported extension source, not a CLI source.
- The first enable starts a full starred-repository import automatically once.
- The popup retains Import for manual refresh and Retry for recoverable failure.
- Public and private starred repositories are treated identically when they
  are visible to the browser's signed-in GitHub session.
- A future star is captured promptly. An unstar does not delete the repository
  from Anansi; it marks the stored item as removed at source.
- Disabling GitHub stops imports and live observation without deleting data.
- GitHub's Sources card and popup row report real running, paused, queued,
  failed, disconnected, and ready states through the existing heartbeat.

## Authentication and permission boundary

The extension adds only `https://github.com/*` to its host permissions. It does
not request the browser `cookies` permission and never reads or exports cookies,
CSRF values, authorization headers, or session storage. GitHub pages and
requests execute in the signed-in tab context; Anansi receives only bounded
repository records and operational state.

If GitHub presents a signed-out page, the import stops with the stable
`not_signed_in` error. The extension leaves its owned GitHub tab open so the
user can sign in, but it never fills credentials, submits a login form, or
handles a verification code.

The extension must reject repository links that do not resolve to
`https://github.com/<owner>/<repository>`. Provider HTML, scripts, forms,
headers, request bodies, and session material are never placed in the capture
queue or heartbeat.

## Repository identity and stored fields

The extension uses normalized lowercase `owner/repository` as the GitHub
external ID. The signed-in stars page does not guarantee the API `node_id`, and
the user's current library contains no GitHub records that require migration.
The existing API-shaped parser is updated to use the same identity, preventing
future CLI fixtures or imports from creating a second row for one repository.
The canonical display title preserves GitHub's original casing.

Each extracted repository may contain only:

- canonical owner/repository and repository URL;
- owner name, handle, and avatar URL when exposed;
- description;
- language, topics, and public/private visibility when exposed;
- stars, forks, open issues, watchers, and updated/pushed date when exposed;
- the page-relative order and next-page cursor.

Missing fields remain absent rather than being guessed. The importer does not
make one request per repository for README or contributor content. The existing
GitHub card renders stored fields with neutral fallbacks. Private repositories
receive an explicit Private label when visibility is available.

## Import architecture

GitHub joins the shared capture-source union used by capture validation,
durable source runs, heartbeat state, popup actions, and server feature flags.
It uses the existing outbox, retry policy, receipt verification, source-serial
delivery, and persisted run cursor.

When GitHub becomes enabled and no successful initial import is recorded:

1. The extension starts a GitHub source run and opens
   `https://github.com/stars` in an inactive tab.
2. A GitHub content script confirms that the page is the signed-in stars view.
3. It extracts one bounded structured page of repository rows and the exact
   next-page link. It does not send raw HTML.
4. The background worker wraps that page in a versioned `raw_page` capture with
   `captureMethod: platform_import` and commits it to the durable outbox.
5. Only after the page is durable does the run advance its cursor.
6. The owned tab follows the validated GitHub next-page link and repeats.
7. A page with no next link completes the run and records that the initial
   import succeeded. The extension closes only the tab it created.

Automatic-first-import state is durable across service-worker and browser
restarts. A failed or interrupted first run resumes rather than starting from
page one. A later manual Import starts an incremental crawl and may stop after
consecutive pages contain no new repositories. Replays remain safe because
database upserts and capture receipts are idempotent.

The server's GitHub parser accepts this bounded extension page shape alongside
the existing GitHub API fixture shape. Both normalize to the same item model;
the extension shape does not become a second persistence path.

## Live star and unstar flow

A narrow main-world observer identifies successful GitHub star and unstar
mutations and reports only the action plus validated owner/repository identity
through the existing nonce-bound page-to-extension relay.

For a star, the background worker records a pending save and requests an
incremental first-page stars refresh. The refreshed repository page is queued
before the precise save event, ensuring that a new repository exists before
its saved state is applied. Both captures use the shared source-serial queue.

For an unstar, the extension immediately queues a content-free `item_event`
with `captureMethod: platform_event`. Existing ingestion retains the item and
sets its removed-at-source state. Re-starring the same repository clears that
state through a newer event.

Duplicate page events, duplicated network observation, and service-worker
restart cannot create duplicate repositories or duplicate receipts.

## Catalogue, popup, and Sources UI

The server catalogue changes GitHub from `coming_next` to `supported`, makes it
toggleable, and includes it in extension-required sources. GitHub is enabled by
default for a newly configured extension; an explicit disabled server setting
still wins.

The extension configuration includes GitHub's import route and captureV2 flag.
The popup uses the existing source-state model:

- Import before or after a completed run;
- Pause while importing;
- Resume after a deliberate pause;
- Retry after delivery or parsing failure;
- Sign in when the stars tab is unauthenticated;
- Synced only when the run is settled and its queue is clear.

The web Sources card gets its state from heartbeat and capture events, not from
item age. It exposes live/import provenance, last successful capture, the
toggle, and a filtered-library link. The GitHub repository card remains a pure
stored-data presentation component and performs no GitHub request at render
time.

## Failure handling

- **Signed out:** stop with `not_signed_in`, keep the owned tab open, and offer
  Sign in/Retry.
- **Unexpected empty extraction:** fail with `page_shape_changed`; do not mark
  the run complete unless the page is an authenticated, genuinely empty stars
  library.
- **Invalid next link:** fail closed unless it is another GitHub stars page.
- **Rate limit or temporary navigation failure:** retain completed pages and
  cursor, schedule bounded retry, and report the condition.
- **Permanent ingest failure:** retain the failed outbox record for explicit
  Retry and surface it through heartbeat and the popup.
- **Extension/server offline:** keep every committed page locally and drain it
  when the server returns.
- **Disable during a run:** pause/stop the source run, close only an owned tab,
  and preserve cursor and queued captures.

Provider error text is reduced to stable local error codes. It is not copied
into heartbeats, logs, or user-visible diagnostics where it could expose page
or account data.

## Verification

### Automated acceptance

- GitHub row extraction accepts representative public and private rows,
  tolerates optional metadata, and rejects malformed/off-site identities.
- Pagination and cursor advancement occur only after durable enqueue.
- Initial-import completion, pause, and resume survive worker restart.
- Automatic import runs once; manual Import remains repeatable and idempotent.
- A star queues repository content before its save event.
- Unstar retains the item and applies removed-at-source state; a later star
  restores it.
- Duplicate observations, repeated pages, and replayed receipts produce one
  repository.
- Signed-out, rate-limit, invalid-next-link, unexpected-empty, delivery, and
  changed-page failures are visible and resumable where appropriate.
- Capture and heartbeat payloads contain no HTML, cookies, tokens, headers,
  request bodies, CSRF values, or session data.
- GitHub source states appear correctly in config, heartbeat, popup, and the
  Sources API/UI.
- Existing X, Reddit, TikTok, Web, and Chrome bookmark tests remain green.

### Build and UI acceptance

- Full tests, root typecheck, extension compile/build, web production build,
  targeted formatting checks, and `git diff --check` pass.
- React Doctor runs after repository-card React changes; unrelated warnings are
  reported separately.
- Repository cards and Sources state are checked at desktop and 320px width.

### Live provider acceptance

Automated fixtures are not evidence that GitHub still behaves as expected.
Completion requires a signed-in browser run covering:

1. automatic initial import;
2. manual incremental Import;
3. one newly starred public repository;
4. one unstar followed by a re-star;
5. one private starred repository, if the account has one available;
6. an interrupted run that resumes without duplication;
7. a heartbeat transition through running to ready.

The final report distinguishes local tests/builds from authenticated GitHub
evidence and from deployed production evidence.

## Out of scope

- GitHub OAuth, personal access tokens, or GitHub App installation.
- Capturing repositories the user merely visits but does not star.
- Cloning repositories or archiving repository files.
- Per-repository README/contributor fetches during import.
- Instagram or any additional platform.
- Redesigning non-GitHub library cards.
