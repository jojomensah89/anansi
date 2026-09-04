# GitHub extension capture implementation plan

**Date:** 2026-09-04
**Design:** `docs/superpowers/specs/2026-09-04-github-extension-capture-design.md`
**Prerequisite design:** `docs/superpowers/specs/2026-09-04-github-repo-card-design.md`
**Goal:** Finish the existing GitHub repository presentation work, then capture
GitHub stars and unstars through the browser's signed-in GitHub session with a
durable automatic first import and no OAuth or personal token.

## Execution rules

- Preserve all existing uncommitted work. At plan creation it consists of the
  GitHub repository-card implementation, Mosaic removal, and the overlapping
  GitHub language projection in `packages/db/src/search.ts`.
- Reconcile and commit the existing work before changing extension behavior.
  Do not reset, stash, or recreate it.
- Use tests before deterministic behavior and keep the proposed commit
  boundaries. Inspect `git status --short` before every commit.
- Do not request `cookies`, `<all_urls>`, OAuth, a personal token, or GitHub App
  installation. The only new provider permission is `https://github.com/*`.
- Never queue or upload GitHub HTML, cookies, CSRF fields, form bodies, request
  headers, session storage, or browser configuration.
- Use normalized lowercase `owner/repository` as GitHub external identity for
  both extension and API-shaped parser input. The current library has no GitHub
  rows, so no data migration is required.
- A page is not acknowledged and its cursor is not advanced until its capture
  is durable in the outbox.
- Automated fixtures and builds are not authenticated GitHub evidence. Report
  live browser acceptance and deployed evidence separately.
- Instagram and other new sources remain out of scope.

## Phase 0: Finish and isolate the existing UI work

### Task 0.1: Complete the GitHub repository card

**Existing dirty files:**

- `apps/web/src/components/card.tsx`
- `apps/web/src/components/github-repo-card.tsx`
- `apps/web/src/components/github-repo-card.test.ts`
- `packages/db/src/search.ts` (language field/projection hunks only)

**Steps:**

1. Inspect the current diff against
   `docs/superpowers/specs/2026-09-04-github-repo-card-design.md`.
2. Fix the `ItemRow.saveOrder` fixture so it is always `number | null`.
3. Confirm the shared card shell delegates GitHub content without changing
   selection, detail opening, removal state, or non-GitHub rendering.
4. Verify language mapping, neutral fallback, missing avatar/description, and
   optional metrics.
5. Stage only the two GitHub language hunks from the overlapping database file.

**Verify:**

```powershell
bun test apps/web/src/components/github-repo-card.test.ts
bun run --cwd apps/web build
git diff --check -- apps/web/src/components/card.tsx apps/web/src/components/github-repo-card.tsx packages/db/src/search.ts
```

**Commit:** `feat(web): render GitHub repository cards`

### Task 0.2: Finish Mosaic removal as a separate change

**Existing dirty files:**

- `apps/web/src/components/skeleton.tsx`
- `apps/web/src/components/views.tsx`
- `apps/web/src/lib/library-search.ts`
- `apps/web/src/lib/library-search.test.ts`
- `apps/web/src/routes/index.tsx`

**Steps:**

1. Remove Mosaic exports, skeletons, route branches, and accepted URL state.
2. Confirm Grid, Row, and Timeline remain available and invalid `view=mosaic`
   falls back to the default view.
3. Keep this commit independent of GitHub capture.

**Verify:**

```powershell
bun test apps/web/src/lib/library-search.test.ts
bun run --cwd apps/web build
git diff --check -- apps/web/src/components/skeleton.tsx apps/web/src/components/views.tsx apps/web/src/lib/library-search.ts apps/web/src/routes/index.tsx
```

**Commit:** `refactor(web): remove Mosaic view`

### Task 0.3: Restore the root typecheck baseline

**Modify narrowly:**

- JSX-bearing component tests currently named `.test.ts`
- `apps/web/src/components/mcp-config.ts`
- The GitHub card fixture if Task 0.1 did not already repair it

**Steps:**

1. Rename JSX-bearing tests to `.test.tsx` rather than weakening compiler
   settings for the entire repository.
2. Remove the stale `windsurf` branch from the already-narrowed MCP client
   switch; do not re-add Windsurf to the UI.
3. Run the root typecheck and treat any new failures by ownership rather than
   broad cleanup.

**Verify:**

```powershell
bun run typecheck
bun test
```

**Commit:** `fix: restore repository typecheck`

## Phase 1: Admit GitHub to the versioned capture contract

### Task 1.1: Extend shared capture and heartbeat source unions

**Modify:**

- `packages/sources/src/capture.ts`
- `packages/sources/src/capture.test.ts`
- `packages/sources/src/extension-heartbeat.ts`
- `packages/sources/src/extension-heartbeat.test.ts`
- `apps/extension/lib/source-runs.ts`
- `apps/extension/lib/source-runs.test.ts`

**Test first:**

- GitHub accepts only `platform_import` and `platform_event` capture methods.
- A GitHub heartbeat source is valid; unknown sources remain rejected.
- Source-run persistence, cursor, pause/resume, pending saves, and owned-tab
  lifecycle work for GitHub.
- `isExpectedImportTab` accepts only GitHub stars URLs on `github.com`.

**Implement:**

- Add `github` to the shared and extension `CaptureSource` unions.
- Keep Web's manual-only capture-method rules unchanged.
- Add GitHub to bounded heartbeat source validation.
- Recognize only `/stars` and validated stars pagination as import tabs.

**Verify:**

```powershell
bun test packages/sources/src/capture.test.ts packages/sources/src/extension-heartbeat.test.ts apps/extension/lib/source-runs.test.ts
bun run --cwd apps/extension compile
```

**Commit:** `feat(sources): admit GitHub extension captures`

### Task 1.2: Expose GitHub through server configuration and catalogue

**Modify:**

- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`
- `apps/web/src/server/source-catalog.ts`
- `apps/web/src/server/source-catalog.test.ts`
- Relevant extension config types

**Test first:**

- `/api/extension/config` includes GitHub with captureV2 enabled and a stars
  entry route when it is not disabled.
- The catalogue marks GitHub supported, toggleable, extension-required, and
  page-mode.
- Disabling GitHub removes it from extension config but not from Sources.
- GitHub runtime state joins into `/api/sources`.

**Implement:**

- Add GitHub's server-owned source definition and feature flag.
- Change the product catalogue from `coming_next` to `supported`.
- Keep the source toggle as the kill switch for observation and imports.

**Verify:**

```powershell
bun test apps/web/src/server/api.test.ts apps/web/src/server/source-catalog.test.ts
```

**Commit:** `feat(web): enable GitHub as an extension source`

## Phase 2: Define bounded GitHub page extraction

### Task 2.1: Build a pure stars-page extractor

**Create:**

- `apps/extension/lib/platforms/github.ts`
- `apps/extension/lib/platforms/github.test.ts`
- Minimal sanitized HTML fixtures under `apps/extension/test/fixtures/github/`

**Test first:**

- Extract representative public and private repository rows.
- Normalize owner/repository identity while preserving display casing.
- Read only allowed optional fields and bounded counts/strings.
- Validate a same-origin GitHub repository URL and reject profile, issue,
  release, off-site, credential-bearing, and malformed URLs.
- Accept a validated next stars-page link and reject every other destination.
- Distinguish signed-out, genuinely empty, ordinary page, and changed-shape
  states without copying page text into errors.
- Extracted payload contains no HTML, forms, cookies, CSRF fields, headers,
  scripts, or credential-shaped keys.

**Implement:**

- Return a small discriminated result: page, signed-out, empty, or
  page-shape-changed.
- Bound rows per page and every optional string/count.
- Keep DOM selectors and normalization in this isolated module.

**Verify:**

```powershell
bun test apps/extension/lib/platforms/github.test.ts
```

**Commit:** `feat(extension): extract bounded GitHub stars pages`

### Task 2.2: Normalize extension and API GitHub pages identically

**Modify:**

- `packages/sources/src/github/parse.ts`
- `packages/sources/src/github/parse.test.ts`
- Add a bounded extension-page fixture if useful

**Test first:**

- API-shaped and extension-shaped records for one repository produce the same
  normalized external ID and canonical URL.
- Public/private visibility, language, owner avatar, description, metrics, and
  dates survive when supplied.
- Missing optional fields are absent or neutral, not fabricated.
- Malformed identities are skipped and an empty valid page stays empty.

**Implement:**

- Add a versioned extension page shape to `parseStarredPage`.
- Change API-shaped identity from `node_id` to normalized owner/repository.
- Preserve raw metadata only within the existing bounded ingestion contract.

**Verify:**

```powershell
bun test packages/sources/src/github/parse.test.ts apps/web/src/server/ingest.test.ts
```

**Commit:** `feat(sources): parse extension GitHub star pages`

## Phase 3: Add GitHub page messaging and live observation

### Task 3.1: Extend the nonce-bound message protocol

**Modify:**

- `apps/extension/lib/messages.ts`
- `apps/extension/lib/messages.test.ts`

**Test first:**

- GitHub page events are accepted only from `github.com` with the matching
  nonce and source derived from sender URL.
- GitHub allows page, done, bookmark, and stable error events plus backfill
  commands; unrelated actions remain rejected.
- `page_shape_changed` and `rate_limited` are stable bounded error codes.
- Payload limits and sensitive-key rejection apply to GitHub records.

**Implement:**

- Add GitHub to `PlatformSource`, host mapping, action mapping, popup commands,
  and error-code validation.
- Do not loosen limits or page-to-background trust boundaries.

**Verify:**

```powershell
bun test apps/extension/lib/messages.test.ts
```

**Commit:** `feat(extension): validate GitHub capture messages`

### Task 3.2: Add GitHub content and main-world scripts

**Create:**

- `apps/extension/entrypoints/github.content.ts`
- `apps/extension/entrypoints/github-main.content.ts`
- Focused tests around pure GitHub helpers; keep browser glue thin

**Modify:**

- `apps/extension/wxt.config.ts`
- Relay registration only where required by WXT entrypoint matching

**Behavior:**

- The isolated content script responds to backfill by extracting the current
  stars page and sending one bounded page event.
- The main-world observer detects successful star/unstar mutations and emits
  only action plus validated owner/repository.
- The existing nonce relay carries events; provider session material never
  crosses it.
- Add `https://github.com/*` host permission and no broader grant.

**Verify:**

```powershell
bun test apps/extension/lib/platforms/github.test.ts apps/extension/lib/messages.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Commit:** `feat(extension): observe GitHub stars in signed-in tabs`

## Phase 4: Orchestrate automatic import and live updates

### Task 4.1: Add durable first-import state

**Modify:**

- `apps/extension/lib/source-runs.ts`
- `apps/extension/lib/source-runs.test.ts`
- `apps/extension/lib/idb-outbox.ts` only if a new sync-state field requires it

**Test first:**

- GitHub initial import is due before its first successful completion.
- Completion is durable across source-run and browser restart.
- Failure, pause, or interruption does not mark initial import complete.
- Disabling and re-enabling does not repeat a completed full import.
- Manual Import remains allowed after completion.

**Implement:**

- Store the smallest durable completion marker in existing sync state.
- Keep completion separate from current run phase and cursor.

**Verify:**

```powershell
bun test apps/extension/lib/source-runs.test.ts apps/extension/lib/idb-outbox.test.ts
```

**Commit:** `feat(extension): remember GitHub initial import completion`

### Task 4.2: Drive GitHub imports from the background worker

**Modify carefully:**

- `apps/extension/entrypoints/background.ts`
- Relevant background/integration tests

**Test first:**

- Configuration/startup requests one automatic GitHub import when due.
- A run opens inactive `/stars`, owns that tab, requests a bounded page,
  durably queues it, persists cursor, navigates to the validated next page, and
  closes its owned tab on completion.
- An existing user-owned stars tab may be reused but is never closed.
- Signed-out leaves the owned tab open and records `not_signed_in`.
- Unexpected empty/changed shape fails visibly and does not advance cursor or
  complete the initial import.
- Pause/disable stops navigation and preserves queued pages/cursor.
- Restart resumes from durable state without duplicate delivery.

**Implement:**

- Add GitHub to entry URLs, host patterns, capture/heartbeat source lists, and
  queue snapshots.
- Reuse `deliverRaw`, source-run cursor, owned-tab lifecycle, and heartbeat
  triggers; do not create a second queue or GitHub-specific storage system.
- Trigger first import asynchronously after valid configuration is loaded.

**Verify:**

```powershell
bun test apps/extension/lib/source-runs.test.ts apps/extension/test/sync.integration.test.ts
bun run --cwd apps/extension compile
```

**Commit:** `feat(extension): run resumable GitHub star imports`

### Task 4.3: Sequence live star and unstar events

**Modify:**

- `apps/extension/entrypoints/background.ts`
- `apps/extension/lib/source-runs.ts` only through its existing pending-save API
- Integration tests

**Test first:**

- A star records one pending identity and requests an incremental refresh.
- The refreshed page is queued before the save event is released.
- An unstar immediately queues a content-free event.
- Repeated observations collapse to one event; re-star after unstar restores
  source state.
- Live handling cannot overlap destructively with a manual import.

**Implement:**

- Reuse pending saves and source-serial queue ordering already used for X.
- Generate deterministic event identity without second-resolution collisions.

**Verify:**

```powershell
bun test apps/extension/test/sync.integration.test.ts packages/db/src/capture-events.test.ts apps/web/src/server/ingest.integration.test.ts
```

**Commit:** `feat(extension): capture GitHub star mutations`

## Phase 5: Finish GitHub status presentation

### Task 5.1: Add GitHub to popup source controls

**Modify:**

- `apps/extension/entrypoints/popup/App.tsx`
- `apps/extension/lib/popup-state.ts`
- `apps/extension/lib/popup-state.test.ts`

**Test first:**

- GitHub offers Import, Pause, Resume, Retry, and Sign in according to durable
  run/queue state.
- A settled imported GitHub source says Synced only when its queue is clear.
- A disabled GitHub row remains visible and offers no capture action.

**Implement:**

- Add GitHub to known popup sources and reuse the shared state mapper.
- Keep auto-first-import status visible without adding a second progress model.

**Verify:**

```powershell
bun test apps/extension/lib/popup-state.test.ts
bun run --cwd apps/extension compile
```

**Commit:** `feat(extension): show GitHub import controls`

### Task 5.2: Update Sources and repository cards for captured metadata

**Modify only if required by the final data contract:**

- `apps/web/src/lib/source-state.ts`
- `apps/web/src/lib/source-state.test.ts`
- `apps/web/src/routes/sources.tsx`
- `apps/web/src/components/github-repo-card.tsx`
- Their focused tests

**Test first:**

- GitHub no longer renders Coming next.
- It exposes a real toggle, live/import/legacy counts, heartbeat state, and
  filtered-library link.
- Private metadata renders a Private label only when stored.
- Existing repository-card states remain intact.

**Verify:**

```powershell
bun test apps/web/src/lib/source-state.test.ts apps/web/src/components/github-repo-card.test.ts apps/web/src/server/source-catalog.test.ts
bun run --cwd apps/web build
```

Run React Doctor after the React changes and classify unrelated warnings
separately.

**Commit:** `feat(web): activate GitHub source status`

## Phase 6: Integrated and live verification

### Task 6.1: Exercise a disposable end-to-end flow

1. Start a disposable local database and current local API on unused ports.
2. Post/queue representative GitHub import and live events.
3. Verify one repository row, explicit import/live provenance, unstar retention,
   re-star restoration, searchability, and Sources counts.
4. Restart the extension test harness during a paginated run and prove resume.
5. Verify heartbeat transitions running → queued if offline → ready after drain.

### Task 6.2: Full automated validation

```powershell
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
git diff --check
```

Run targeted Biome checks without repository-wide write formatting. Run React
Doctor for changed React files. Inspect `git status --short` and confirm no
unrelated files were committed.

### Task 6.3: Browser acceptance with the unpacked extension

Using the user's existing signed-in GitHub browser session:

1. Load the freshly built unpacked extension and configure the current local
   Anansi server/token.
2. Verify the extension heartbeat becomes Connected and reports its version.
3. Enable GitHub and observe one automatic import without foreground takeover.
4. Verify manual incremental Import and visible progress.
5. Star one public repository, verify it arrives once, then unstar and re-star
   it while checking retained/restored source state.
6. Verify one private starred repository if the account has one available;
   never expose its name in test logs or the completion report.
7. Interrupt and resume one run without duplicates.
8. Check GitHub cards, popup, and Sources at desktop and 320px width.

Stop at sign-in if the session is unavailable. Do not enter credentials or
verification codes.

## Completion report

Report separately:

- commits and changed modules;
- automated tests, typecheck, builds, formatting/diff checks, and React Doctor;
- local disposable-flow evidence;
- authenticated GitHub import/star/unstar/private-repository evidence;
- any unverified provider or production behavior;
- unchanged X/Reddit/TikTok/Chrome acceptance gaps, if still present.

## Final acceptance checklist

- [ ] Existing GitHub repository-card work is reviewed and committed.
- [ ] Mosaic removal is independently committed.
- [ ] Root typecheck passes.
- [ ] GitHub uses extension session only; no OAuth, token, or cookie permission.
- [ ] One automatic initial import runs and completes durably.
- [ ] Manual import, pause/resume, retry, and sign-in states work.
- [ ] Pagination advances only after durable enqueue and resumes after restart.
- [ ] Public and visible private starred repositories normalize to one identity.
- [ ] Star content is queued before save; unstar retains; re-star restores.
- [ ] Capture and heartbeat payloads contain no HTML or session material.
- [ ] GitHub is supported/toggleable in config, popup, Sources, and heartbeat.
- [ ] Repository cards render stored metadata with neutral fallbacks.
- [ ] Existing sources and unsave retention remain intact.
- [ ] Full tests, typecheck, builds, diff checks, and React Doctor are complete.
- [ ] Authenticated GitHub acceptance is reported separately from local proof.
