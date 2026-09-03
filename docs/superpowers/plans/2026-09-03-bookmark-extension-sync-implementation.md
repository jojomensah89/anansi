# Anansi Reliable Bookmark Capture and Sync Implementation Plan

**Date:** 2026-09-03
**Design:** `docs/superpowers/specs/2026-09-03-bookmark-extension-sync-design.md`
**Goal:** Reliably capture X, Reddit, TikTok, explicit webpage saves, and optional Chrome bookmarks into Anansi's canonical SQLite library without copying platform cookies or losing events when the Manifest V3 worker stops.

## Execution rules

- Preserve unrelated and pre-existing work. At plan creation, `apps/extension/entrypoints/background.ts` and `apps/extension/entrypoints/popup/App.tsx` contain uncommitted stale-run UI work. Reconcile those edits during the relevant tasks; never reset or overwrite them.
- Work in the sequence below. Keep each numbered task independently testable and use the suggested commit boundaries.
- Add tests before behavior wherever the module has a deterministic interface.
- Keep the existing `{ source, raw }` and `{ items }` ingestion shapes operational until the final retirement task.
- Do not add `cookies` or `<all_urls>` permissions.
- Do not claim X, Reddit, or TikTok support from fixtures alone. Authenticated browser acceptance is a separate gate.
- Never put the Anansi ingestion token in page-world messages, captured raw data, logs, or diagnostics.
- Exactly one delivery path owns an event. Feature flags must not dual-write through both direct upload and the queue.

## Phase 0: Protect the baseline

### Task 0.1: Record and verify the starting state

**Inspect:**

- `apps/extension/entrypoints/background.ts`
- `apps/extension/entrypoints/popup/App.tsx`
- `apps/extension/wxt.config.ts`
- `apps/web/src/server/api.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/queries.ts`
- `packages/db/src/search.ts`

**Steps:**

1. Run `git status --short` and save the exact list of pre-existing edits in the implementation task notes.
2. Run the focused baseline:

   ```powershell
   bun test apps/web/src/server/api.test.ts packages/sources/src/reddit/parse.test.ts packages/sources/src/github/parse.test.ts packages/db/src/search.test.ts
   bun run --cwd apps/extension compile
   bun run --cwd apps/extension build
   ```

3. If a baseline failure exists, record it separately. Do not broaden this project into unrelated cleanup.
4. Confirm the current generated manifest still has only the existing restricted hosts and no cookie permission.

**Exit condition:** Baseline results and pre-existing diffs are known before implementation files change.

## Phase 1: Shared capture and identity contracts

### Task 1.1: Add the versioned capture envelope

**Create:**

- `packages/sources/src/capture.ts`
- `packages/sources/src/capture.test.ts`

**Modify:**

- `packages/sources/src/item.ts`
- `packages/sources/src/index.ts`

**Test first:**

Add tests that prove:

- A raw-page capture requires `runId`, `page`, `source`, `observedAt`, and bounded raw data.
- An item event requires `action`, `externalId`, `canonicalUrl`, and an allowed capture method.
- `unsave` may omit `normalizedItem`; a new `save` cannot be applied without item content unless the item already exists.
- Unknown sources, actions, schema versions, oversized payloads, and malformed timestamps are rejected.
- Validation returns a sanitized error and never echoes raw payload or credential-looking fields.

**Implement:**

- `CaptureBase`, `RawPageCapture`, `ItemEventCapture`, `BookmarkCapture`, `CaptureReceipt`, and queue-status types.
- A small runtime validator such as `parseBookmarkCapture(value, limits)`; do not rely only on TypeScript types.
- Expand `Source` to include `web` while retaining all current sources.
- Expand `Kind` only for kinds actually emitted by existing Reddit, TikTok, and web parsers (`post`, `comment`, `video`, `article`, `repo`).
- Export the contract and validator from `packages/sources/src/index.ts`.

**Verify:**

```powershell
bun test packages/sources/src/capture.test.ts packages/sources/src/reddit/parse.test.ts packages/sources/src/github/parse.test.ts
bun run typecheck
```

**Suggested commit:** `feat(sources): add versioned bookmark capture contract`

### Task 1.2: Add conservative web URL identity

**Create:**

- `packages/sources/src/web/canonical-url.ts`
- `packages/sources/src/web/canonical-url.test.ts`

**Modify:**

- `packages/sources/src/index.ts`

**Test first:**

Cover host/scheme casing, default ports, fragments, `utm_*`, `fbclid`, `gclid`, duplicate query values, query ordering, meaningful application parameters, invalid protocols, and canonical-link candidates that point to another origin.

**Implement:**

- `canonicalizeWebUrl(input, canonicalCandidate?)`.
- Strip only an explicit tracking-parameter allowlist.
- Preserve unknown parameters and path casing.
- Accept `http` and `https` only.
- Derive a deterministic web external ID from the canonical URL using Web Crypto or another runtime-portable hash.

**Verify:**

```powershell
bun test packages/sources/src/web/canonical-url.test.ts
```

**Suggested commit:** `feat(sources): define generic web bookmark identity`

## Phase 2: Canonical database state and idempotency

### Task 2.1: Add capture-event and source-link schema

**Modify:**

- `packages/db/src/schema.ts`
- `packages/db/src/types.ts`
- `packages/db/src/index.ts`

**Generate:**

- The next Drizzle migration under `packages/db/drizzle/`
- Corresponding `packages/db/drizzle/meta/` files

**Schema changes:**

- Add `platform_saved`, `removed_from_source_at`, and `last_source_event_at` to `items`.
- Backfill existing items as currently saved without changing their archive state.
- Add `capture_events` keyed by unique `event_id`, with source, action, external ID, observed/received times, item ID, outcome, and serialized stable receipt.
- Add `item_source_links` keyed by `(kind, external_id)` with item ID, present state, and observed time.
- Add indexes needed for event lookup, item source state, and source-link lookup.

**Migration requirements:**

- Migration is additive and safe for an existing local database.
- Existing unique `(source, external_id)` behavior remains.
- Existing items, FTS tables, media, tags, and archive state remain intact.

**Verify:**

```powershell
bun run db:generate -- --name capture_events
git diff --check
bun run typecheck
```

Inspect generated SQL before executing it against the user's real database.

**Suggested commit:** `feat(db): add capture events and source state`

### Task 2.2: Implement atomic capture application

**Create:**

- `packages/db/src/capture-events.ts`
- `packages/db/src/capture-events.test.ts`
- `packages/db/src/test-db.ts`

**Modify:**

- `packages/db/src/queries.ts`
- `packages/db/src/index.ts`

**Test first with a temporary migrated SQLite database:**

- First save creates an item and `created` receipt.
- Replaying the same `eventId` returns the same receipt.
- A second event for the same source object updates one item.
- A newer unsave sets `platformSaved = 0` and `removedFromSourceAt` without deleting the item.
- An older delayed save is recorded as `ignored_stale` and does not resurrect source state.
- Saving again with a newer event clears `removedFromSourceAt`.
- Two Chrome bookmark nodes can reference one web item.
- Removing one node leaves the other present; removing the last marks Chrome presence false without deleting the item.
- A transaction failure stores neither a partial event nor partial item state.

**Implement:**

- Extract a transaction-compatible internal item-upsert function from `upsertItems`; keep the existing exported `upsertItems` interface unchanged.
- Add `applyCapture(db, capture, parsedItems)` as the one database interface for new capture envelopes.
- Resolve an existing event before parsing or mutating whenever possible.
- Store the stable receipt in `capture_events` and return it on replay.
- Apply source state only when `observedAt >= lastSourceEventAt`.
- Keep archive state independent from platform-saved state.

**Verify:**

```powershell
bun test packages/db/src/capture-events.test.ts
bun test packages/db/src/search.test.ts
```

**Suggested commit:** `feat(db): apply bookmark captures idempotently`

### Task 2.3: Make saved-order pagination total and stable

**Modify:**

- `packages/db/src/search.ts`
- `packages/db/src/search.test.ts`
- `apps/web/src/server/api.test.ts`

**Test first:**

- Multiple rows sharing `saveOrder` appear exactly once across pages.
- Null `saveOrder` rows are eventually returned.
- Inserting a newer item while paging does not repeat or skip previously reachable rows.
- Cursor decoding rejects malformed input with a controlled 400 response.

**Implement:**

- Encode saved-order cursors with both an effective order key and item ID.
- Use the same effective-order expression in `ORDER BY` and keyset comparison.
- Define deterministic placement for null source order using saved/first-seen metadata.
- Preserve posted-order cursor behavior.

**Verify:**

```powershell
bun test packages/db/src/search.test.ts apps/web/src/server/api.test.ts
```

**Suggested commit:** `fix(db): make saved pagination deterministic`

## Phase 3: Backward-compatible ingestion protocol

### Task 3.1: Add the deep ingestion module and stable receipts

**Create:**

- `apps/web/src/server/ingest.ts`
- `apps/web/src/server/ingest.test.ts`

**Modify:**

- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`

**Test first:**

- Existing `{ source, raw }` payloads still parse and return their current result shape.
- Existing `{ items }` payloads still work.
- A versioned capture requires bearer auth and matching `Idempotency-Key`/`eventId`.
- A repeated event returns the same receipt.
- A raw-page capture parses server-side with the existing source parser.
- A zero-parse raw page returns 422 and does not acknowledge/remove the event.
- Unknown versions, sources, actions, oversized bodies, and malformed normalized items fail safely.
- An unsave never schedules media work or deletes content.
- Responses and logs do not contain the bearer token, cookie-like fields, or full rejected raw payload.

**Implement:**

- Move ingestion decision logic out of the route into `ingestCapture`.
- Route legacy bodies through the existing behavior unchanged.
- Route versioned envelopes through validation, source parsing where `payloadType === "raw_page"`, and `applyCapture`.
- Return `{ eventId, itemId, outcome }` plus parsed counts for raw pages where useful.
- Keep asynchronous media synchronization only for newly created/updated item content.
- Cap request bytes before JSON parsing and cap diagnostic shape output.

**Verify:**

```powershell
bun test apps/web/src/server/ingest.test.ts apps/web/src/server/api.test.ts
bun run typecheck
```

**Suggested commit:** `feat(web): accept durable capture envelopes`

### Task 3.2: Version extension configuration without breaking old clients

**Modify:**

- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`
- `apps/extension/entrypoints/background.ts`

**Test first:**

- Config advertises an ingestion protocol version and feature switches.
- Old fields remain readable by the current extension.
- TikTok config includes only the collected/Favorites listing endpoint.
- Changing the configured Anansi server invalidates cached config.

**Implement:**

- Add `ingestProtocolVersion: 2` and explicit per-source feature switches.
- Retain `version`, `enabled`, `ingest`, and current source fields during migration.
- Remove `/api/favorite/item_list` and `/api/user/favorite/item_list` from TikTok bookmark configuration.
- Key extension config cache by normalized server origin.

**Verify:**

```powershell
bun test apps/web/src/server/api.test.ts
bun run --cwd apps/extension compile
```

**Suggested commit:** `feat(extension): negotiate capture protocol version`

## Phase 4: Durable extension queue

### Task 4.1: Build and test the queue through its interface

**Create:**

- `apps/extension/lib/capture-queue.ts`
- `apps/extension/lib/capture-queue.test.ts`
- `apps/extension/lib/idb-outbox.ts`
- `apps/extension/lib/idb-outbox.test.ts`
- `apps/extension/lib/ingest-transport.ts`
- `apps/extension/lib/queue-test-adapters.ts`

**Modify:**

- `apps/extension/package.json`
- `bun.lock`

Add `@anansi/sources` as a workspace dependency. Add `fake-indexeddb` as a development dependency only if the real IndexedDB adapter cannot be exercised with the current test runtime.

**Test first through `CaptureQueue`:**

- `enqueue` writes before the first transport call.
- A 2xx receipt removes the matching record.
- Worker termination after persistence leaves a recoverable record.
- Startup changes abandoned `uploading` records back to `queued`.
- Network errors and 408/425/429/5xx responses calculate bounded retry times.
- `Retry-After` takes precedence over exponential backoff.
- 400/401/403/413/422 become visible failed records and do not spin.
- Retries preserve the same event ID and payload hash.
- Processing is serial per source and bounded globally.
- Queue limits strip optional raw diagnostics before rejecting required normalized content.
- Status counts derive from persisted records, not process globals.

**Implement:**

- IndexedDB database `anansi-extension`, initially version 1.
- `outbox` store keyed by `eventId`, with indexes for status, source, and `nextAttemptAt`.
- `syncState` store for run cursor/checkpoint and source lifecycle.
- Inject storage, HTTP transport, clock, randomness, and wake scheduler into the queue implementation.
- Keep the external queue interface to `enqueue`, `getStatus`, and `retry`; internal draining and scheduling remain hidden.
- Send `Idempotency-Key` and verify that the returned receipt matches the queued event before deletion.

**Verify:**

```powershell
bun test apps/extension/lib/capture-queue.test.ts apps/extension/lib/idb-outbox.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Suggested commit:** `feat(extension): add durable capture outbox`

### Task 4.2: Route the background worker through the queue

**Create:**

- `apps/extension/lib/source-runs.ts`
- `apps/extension/lib/source-runs.test.ts`

**Modify:**

- `apps/extension/entrypoints/background.ts`
- `apps/extension/entrypoints/popup/App.tsx`

**Preserve:**

- Reconcile the existing uncommitted `startedAt`, stalled-run, and Stop-button work. Keep useful behavior, but make persisted queue/run state authoritative.

**Test first:**

- Runtime message handlers return their promises and report controlled results.
- Startup/install/alarm wake the queue.
- Per-source runs cannot overlap.
- Multiple live refresh signals coalesce durably.
- Only tabs created by Anansi are closed.
- A platform tab is selected only when it is at the expected import route; otherwise open a dedicated inactive tab.
- Changing server settings invalidates cached config and transport state.

**Implement:**

- Replace direct `upload()` calls with queue enqueue operations.
- Remove `savedTimers` and `closeWhenDone` as authorities; use durable run records and tab ownership metadata.
- Keep short timers only for in-awake UI/debounce convenience.
- Return a promise from the runtime listener for asynchronous actions.
- Derive popup status from queue and sync-state records.
- Use alarms for retry and scheduled synchronization.
- Add a protocol feature flag so legacy direct upload can remain available but never active for the same capture.

**Verify:**

```powershell
bun test apps/extension/lib/source-runs.test.ts apps/extension/lib/capture-queue.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Suggested commit:** `refactor(extension): deliver captures through durable queue`

## Phase 5: Message trust seam

### Task 5.1: Validate page, relay, and background messages

**Create:**

- `apps/extension/lib/messages.ts`
- `apps/extension/lib/messages.test.ts`

**Modify:**

- `apps/extension/entrypoints/relay.content.ts`
- `apps/extension/entrypoints/background.ts`
- All platform MAIN-world scripts as their message shapes migrate

**Test first:**

- Reject unknown message names, sources, actions, versions, and oversized payloads.
- Reject a claimed source that does not match the sender tab URL.
- Reject page commands on the page-to-extension path.
- Accept only the expected message family for X, Reddit, or TikTok origins.
- Sanitize errors without reflecting raw content.

**Implement:**

- Define discriminated runtime-message guards.
- Use `sender.url`/`sender.tab.url` to derive the source in the background rather than trusting `msg.source`.
- Add a per-tab correlation nonce to reduce accidental cross-talk. Document that a nonce visible to MAIN-world code is not a defense against malicious code already executing in that page.
- Enforce payload byte/shape limits in relay and background.
- Keep configuration secrets and the ingestion token entirely out of MAIN-world messages.

**Verify:**

```powershell
bun test apps/extension/lib/messages.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Suggested commit:** `security(extension): validate capture messages at relay seam`

## Phase 6: Platform adapters

### Task 6.1: Make X import and mutation capture precise

**Create:**

- `apps/extension/lib/platforms/x.ts`
- `apps/extension/lib/platforms/x.test.ts`
- Sanitized X request/response fixtures under `apps/extension/test/fixtures/x/`

**Modify:**

- `apps/extension/entrypoints/x-main.content.ts`
- `apps/extension/entrypoints/background.ts`
- `apps/web/src/server/api.ts` only if current configuration fields need adjustment

**Test first:**

- Extract `tweet_id` and action from Create/DeleteBookmark fetch and XHR requests.
- Emit nothing for failed mutation responses.
- Recognize both bookmark timeline response variants already supported by the server parser.
- Capture a sanitized request template without persisting authorization, CSRF, cookies, or unrelated headers.
- Resume from the last acknowledged cursor.
- Stop at repeated cursor, zero items, page limit, or stable known-ID overlap.

**Implement:**

- Require or open `https://x.com/i/bookmarks` for import instead of selecting an arbitrary X tab.
- Observe a successful Bookmarks request produced by X and reuse its URL/variables/features template for that run.
- Continue allowing the browser to attach the signed-in session; use JavaScript-visible CSRF only transiently inside X.
- Emit explicit item-event `save`/`unsave` captures with tweet ID and observed time.
- For save content, capture the exact item from an observed response or a coalesced first-page refresh before acknowledgement.
- Queue every raw timeline page before advancing its durable cursor.

**Verify:**

```powershell
bun test apps/extension/lib/platforms/x.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Authenticated gate:** Saving and unsaving one X bookmark updates the local web UI correctly; restarting with an offline queued save delivers it after recovery.

**Suggested commit:** `fix(extension): make X bookmark capture precise and resumable`

### Task 6.2: Add explicit Reddit save/unsave events

**Create:**

- `apps/extension/lib/platforms/reddit.ts`
- `apps/extension/lib/platforms/reddit.test.ts`
- Sanitized Reddit action fixtures under `apps/extension/test/fixtures/reddit/`

**Modify:**

- `apps/extension/entrypoints/reddit-main.content.ts`
- `apps/extension/entrypoints/reddit.content.ts`

**Test first:**

- Distinguish `/api/save` from `/api/unsave`.
- Extract the Reddit fullname from fetch and XHR request bodies.
- Handle posts and comments.
- Preserve `after` only after the page capture is acknowledged.
- Respect 429/`Retry-After` without relying on one long-lived in-page timer.

**Implement:**

- Emit precise action/fullname events from the MAIN-world observer.
- Keep `/api/me.json` username resolution and signed-in same-origin listing fetch.
- Fetch the affected object or coalesce a first-page refresh for save content.
- Queue each listing page as a raw-page capture and persist its cursor after receipt.

**Verify:**

```powershell
bun test apps/extension/lib/platforms/reddit.test.ts packages/sources/src/reddit/parse.test.ts
bun run --cwd apps/extension compile
```

**Authenticated gate:** Save/unsave both a Reddit post and comment and verify retained local state.

**Suggested commit:** `fix(extension): track Reddit save state explicitly`

### Task 6.3: Anchor TikTok to Favorites and observed signed traffic

**Create:**

- `apps/extension/lib/platforms/tiktok.ts`
- `apps/extension/lib/platforms/tiktok.test.ts`
- Sanitized authenticated fixtures under `apps/extension/test/fixtures/tiktok/`

**Modify:**

- `apps/extension/entrypoints/tiktok-main.content.ts`
- `apps/extension/entrypoints/background.ts`
- `packages/sources/src/tiktok/parse.ts`
- Add `packages/sources/src/tiktok/parse.test.ts`

**Test first:**

- Accept `/api/user/collect/item_list/` item-list responses.
- Reject Likes endpoint payloads as bookmark imports.
- Parse the current authenticated `itemList` fixture.
- Detect the verified favorite/collection mutation and video identifier.
- Never synthesize or persist TikTok signing values.
- Stop/resume a scan using durable progress rather than body-height state alone.

**Implement:**

- Discover/open the current user's Favorites or Collections route.
- Observe TikTok-generated signed requests and cloned responses.
- Queue collected-item pages before advancing progress.
- Observe the verified favorite-button mutation for ongoing saves and unsaves.
- Replace root-page body scrolling with Favorites-container/page-driven loading.
- Keep endpoint matching configurable so server config can disable a broken adapter.

**Verify:**

```powershell
bun test apps/extension/lib/platforms/tiktok.test.ts packages/sources/src/tiktok/parse.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Authenticated gate:** Capture an existing Favorites page, favorite a new video, then unfavorite it; verify one retained local item with correct current state.

**Suggested commit:** `fix(extension): capture TikTok Favorites from observed traffic`

## Phase 7: Generic web and Chrome capture

### Task 7.1: Add explicit current-page capture

**Create:**

- `apps/extension/lib/page-capture.ts`
- `apps/extension/lib/page-capture.test.ts`

**Modify:**

- `apps/extension/wxt.config.ts`
- `apps/extension/entrypoints/background.ts`
- `apps/extension/entrypoints/popup/App.tsx`
- `packages/sources/src/item.ts`

**Test first:**

- Extract title, description, same-origin canonical URL, Open Graph image, site name, favicon, selected text, and bounded readable text.
- Exclude password fields, hidden form values, scripts, styles, and oversized document content.
- Reject `chrome://`, extension, file, data, and unsupported protocols with a clear result.
- Toolbar and context-menu capture of the same canonical URL upsert one item.

**Implement:**

- Add `activeTab`, `scripting`, and `contextMenus` permissions.
- Add “Save page to Anansi” and “Save selection to Anansi” context-menu entries.
- Add a popup “Save current page” action so the existing popup remains the toolbar interface.
- Inject extraction only in direct response to the user action.
- Normalize the result as a web item and enqueue it through the same durable queue.
- Do not add `<all_urls>`.

**Verify:**

```powershell
bun test apps/extension/lib/page-capture.test.ts packages/sources/src/web/canonical-url.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Browser gate:** Save an article, a GitHub page, a selected paragraph, and an unsupported browser page; verify expected item/error behavior.

**Suggested commit:** `feat(extension): save the active webpage explicitly`

### Task 7.2: Add optional Chrome bookmark mirroring

**Create:**

- `apps/extension/lib/chrome-bookmarks.ts`
- `apps/extension/lib/chrome-bookmarks.test.ts`

**Modify:**

- `apps/extension/wxt.config.ts`
- `apps/extension/entrypoints/background.ts`
- `apps/extension/entrypoints/popup/App.tsx`

**Test first:**

- Enabling requests permission once and starts listeners only after grant.
- Denial leaves mirroring disabled without affecting other capture paths.
- Initial tree import ignores folders and unsupported URLs.
- Create/change/remove events map to stable item/source-link events.
- Duplicate URLs in two folders remain present until both bookmark nodes are removed.
- Disabling mirroring removes listeners and optional permission but does not delete Anansi items.

**Implement:**

- Declare `bookmarks` under optional permissions.
- Add an independent mirroring toggle and one-time import action.
- Translate Chrome bookmark events into `source: "web"`, `captureMethod: "chrome_bookmark"` item events.
- Use bookmark node ID as the source-link external ID and canonical URL as the item identity.
- Persist import checkpoint/progress so a large tree can resume.

**Verify:**

```powershell
bun test apps/extension/lib/chrome-bookmarks.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Browser gate:** Grant, deny, disable, initial-import, add, edit, duplicate, and remove Chrome bookmarks without affecting platform adapters.

**Suggested commit:** `feat(extension): optionally mirror Chrome bookmarks`

## Phase 8: Recovery UI and operational clarity

### Task 8.1: Replace message strings with persisted source/queue state

**Modify:**

- `apps/extension/entrypoints/popup/App.tsx`
- `apps/extension/entrypoints/popup/App.css`
- `apps/extension/entrypoints/background.ts`

**Create:**

- `apps/extension/lib/popup-state.ts`
- `apps/extension/lib/popup-state.test.ts`

**Test first:**

- Status distinguishes ready, running, queued, retrying, failed, sign-in required, paused, disabled, and synced.
- “Synced” is impossible while acknowledged work is incomplete.
- Retry one/all and pause/resume send the correct commands.
- Sensitive errors are redacted.
- Existing stale-run work maps cleanly into durable run state.

**Implement:**

- Present per-source status plus global pending/retrying/failed totals.
- Add Retry, Retry all, Pause/Resume, sign-in navigation, and sanitized diagnostics.
- Keep Stop semantics as Pause: persisted progress remains and no queued capture is deleted.
- Show Chrome mirroring separately from generic web readiness.
- Ensure keyboard access, focus visibility, and narrow-popup scrolling.

**Verify:**

```powershell
bun test apps/extension/lib/popup-state.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

Run React Doctor after the React changes and fix only findings introduced or exposed by this patch.

**Suggested commit:** `feat(extension): expose durable sync and recovery state`

## Phase 9: Integration, rollout, and retirement

### Task 9.1: Run failure-injection integration tests

**Create:**

- `apps/extension/test/sync.integration.test.ts`
- `apps/web/src/server/ingest.integration.test.ts`

**Scenarios:**

- Server offline during save, then online.
- Worker terminated after IndexedDB commit, before fetch, during fetch, and after server commit but before local deletion.
- Duplicate delivery after an ambiguous network failure.
- 429 with and without `Retry-After`.
- 401 after token rotation.
- 422 after parser-shape drift.
- Older save delivered after newer unsave.
- Two rapid sources syncing concurrently without same-source overlap.
- Queue storage pressure and raw-payload stripping.
- Browser restart during initial import.

**Verify:**

```powershell
bun test apps/extension/test/sync.integration.test.ts apps/web/src/server/ingest.integration.test.ts
```

**Suggested commit:** `test(extension): cover interrupted bookmark delivery`

### Task 9.2: Perform authenticated browser acceptance source by source

**Do not automate credentials or codes.** Reuse the user's existing signed-in browser session. If a source is signed out, open the sign-in page and hand control back to the user.

For each source:

1. Enable only that source's new capture flag.
2. Import a small bounded page.
3. Save one new item and confirm queue state, server receipt, SQLite row, and web UI card.
4. Unsave it and confirm the local item remains with source state cleared.
5. Repeat with the local server temporarily offline.
6. Restart/reload the extension with one queued event.
7. Capture sanitized request/response fixtures if the live shape differs from tests.
8. Record exact browser, extension build, server origin, source account state, and timestamp.

Do this in order: X, Reddit, TikTok, generic web, then Chrome bookmarks. Do not enable the next source until the current source passes or is explicitly left disabled with a documented failure.

### Task 9.3: Remove legacy direct delivery only after acceptance

**Modify:**

- `apps/extension/entrypoints/background.ts`
- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`
- `apps/extension/README.md`
- Root `README.md` if it documents extension behavior

**Steps:**

- Remove direct in-memory upload/debounce code after all enabled adapters use the queue.
- Keep legacy server body support for at least one compatibility release unless all non-extension callers are proven migrated.
- Remove migration feature flags only after rollback is no longer needed.
- Document permissions, local-only token scope, recovery behavior, and authenticated verification date.

**Final automated verification:**

```powershell
bun test
bun run typecheck
bun run check-types
bun run build
git diff --check
```

Do not run `bun run check` merely as validation because it writes formatting across the repository. If formatting is needed, target only files changed by this implementation.

**Final manual verification:**

- Inspect the generated manifest: no `cookies`, no `<all_urls>`, and `bookmarks` remains optional.
- Confirm no capture payload or diagnostic contains the Anansi token, cookies, CSRF token, or platform authorization header.
- Confirm the existing local library count, archive state, media references, and tags survived migration.
- Confirm the web UI reflects acknowledged saves from all five capture paths.
- Confirm source unsaves never hard-delete local items.

**Suggested commit:** `refactor(extension): retire transient bookmark delivery`

## Completion evidence

Implementation is complete only with:

- Focused and full automated-test results.
- Extension compile and production build results.
- Generated-manifest permission inspection.
- Migration readback against a copied database before touching the canonical local database.
- Authenticated acceptance evidence for each enabled social source.
- Offline/restart recovery evidence.
- A final `git status --short` separating implementation changes from the pre-existing `background.ts`/`App.tsx` edits if those edits remain user-owned.
