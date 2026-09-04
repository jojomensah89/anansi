# Extension health and Sources truth implementation plan

**Date:** 2026-09-04  
**Design:** `docs/superpowers/specs/2026-09-04-extension-health-sources-truth-design.md`  
**Goal:** Replace age-derived source health with a durable extension heartbeat, explicit first-arrival provenance, a server-owned source catalogue, and honest zero-item source cards.

## Execution rules

- Preserve all pre-existing uncommitted work. At plan creation, the GitHub repository-card changes touch `apps/web/src/components/card.tsx`, `apps/web/src/components/skeleton.tsx`, `apps/web/src/components/views.tsx`, `apps/web/src/lib/library-search.ts`, its test, `apps/web/src/routes/index.tsx`, and `packages/db/src/search.ts`, with two untracked GitHub-card files. Never reset, stash, overwrite, or accidentally commit those changes.
- `packages/db/src/search.ts` overlaps this implementation. Reconcile its current working-tree content and make only targeted source-health edits.
- Add tests before deterministic behavior. Keep each task independently verifiable and use the proposed commit boundaries.
- Do not change platform permissions, capture endpoints, or provider parsing in this increment.
- Do not add GitHub or Instagram capture. GitHub remains `coming_next`; TikTok remains `experimental`.
- Heartbeats must never contain tokens, platform session data, saved URLs, raw payloads, or provider headers.
- Do not infer historical provenance from `saved_at_exact`. Existing items and capture events migrate to `legacy_unknown`.
- Authenticated X, Reddit, and TikTok acceptance is not part of local completion evidence.

## Phase 0: Protect and verify the baseline

### Task 0.1: Record dirty state and focused baseline

**Inspect:**

- `git status --short`
- `packages/db/src/schema.ts`
- `packages/db/src/queries.ts`
- `packages/db/src/capture-events.ts`
- `packages/db/src/search.ts`
- `apps/web/src/server/api.ts`
- `apps/web/src/routes/sources.tsx`
- `apps/extension/entrypoints/background.ts`
- `apps/extension/lib/source-runs.ts`
- `apps/extension/lib/capture-queue.ts`

**Steps:**

1. Record the exact pre-existing dirty paths in implementation notes.
2. Inspect the current diff for `packages/db/src/search.ts` before editing the overlapping source-health query.
3. Run the focused baseline:

   ```powershell
   bun test packages/db/src/capture-events.test.ts packages/db/src/search.test.ts apps/web/src/server/api.test.ts apps/extension/lib/source-runs.test.ts apps/extension/lib/capture-queue.test.ts
   bun run --cwd apps/extension compile
   bun run --cwd apps/web build
   ```

4. Record failures as pre-existing and do not broaden scope to fix unrelated work.

**Exit condition:** The starting diff and relevant baseline are known before implementation edits.

## Phase 1: Explicit capture provenance

### Task 1.1: Add immutable item origin and capture-event method

**Modify:**

- `packages/db/src/schema.ts`
- `packages/db/src/queries.ts`
- `packages/db/src/capture-events.ts`
- `packages/db/src/index.ts`, only if new public types/functions require export

**Generate:**

- `packages/db/drizzle/0008_*.sql`
- `packages/db/drizzle/meta/0008_snapshot.json`
- `packages/db/drizzle/meta/_journal.json`

**Test first:**

- Extend `packages/db/src/capture-events.test.ts` to prove a platform event creates an item with `platform_event` origin.
- Prove a raw import page creates items with `platform_import` origin.
- Prove toolbar, context-menu, and Chrome-bookmark captures retain their specific origins.
- Prove an import followed by a live event does not change the original item origin.
- Prove an existing/legacy row remains `legacy_unknown` after later metadata updates.
- Prove new capture-event receipts persist `captureMethod`.

**Implement:**

- Add `capture_origin` to `items`, non-null with default `legacy_unknown`.
- Add `capture_method` to `capture_events`, non-null with default `legacy_unknown` for existing rows.
- Define a narrow database type for persisted origins: the five capture methods plus `legacy_unknown`.
- Let `upsertItemsInTransaction` receive an optional insertion origin. Set it on insert and deliberately omit it from conflict updates.
- Pass `capture.captureMethod` from both raw-page and item-event application paths.
- Persist the method in `recordReceipt`.
- Generate and inspect the additive migration; do not execute it against the user's real database during generation.

**Verify:**

```powershell
bun test packages/db/src/capture-events.test.ts
bun run db:generate -- --name extension_health_provenance
git diff --check -- packages/db
```

**Suggested commit:** `feat(db): track immutable capture provenance`

### Task 1.2: Replace timestamp-derived source counts

**Modify carefully:**

- `packages/db/src/search.ts`
- `packages/db/src/search.test.ts`
- `apps/web/src/lib/api.ts`

**Test first:**

- Source health reports separate `live`, `imported`, `toolbar`, `contextMenu`, `chromeBookmarks`, and `legacyUnknown` counts.
- An exact timestamp on a `platform_import` item remains imported.
- A `platform_event` item with a non-exact provider timestamp remains live.
- Existing source totals, media totals, author counts, and removal filters remain unchanged.

**Implement:**

- Replace `saved_at_exact` count expressions with `capture_origin` expressions.
- Keep timestamp precision fields for date honesty; do not remove or reinterpret them.
- Update `SourceRow` types to match the explicit provenance response.
- Preserve unrelated working-tree modifications already present in `search.ts`.

**Verify:**

```powershell
bun test packages/db/src/search.test.ts apps/web/src/server/api.test.ts
git diff --check -- packages/db/src/search.ts apps/web/src/lib/api.ts
```

**Suggested commit:** `fix(db): derive source counts from capture origin`

## Phase 2: Heartbeat contract and persistence

### Task 2.1: Define and validate the heartbeat envelope

**Create:**

- `packages/sources/src/extension-heartbeat.ts`
- `packages/sources/src/extension-heartbeat.test.ts`

**Modify:**

- `packages/sources/src/index.ts`

**Contract:**

```ts
interface ExtensionHeartbeat {
  schemaVersion: 1;
  installationId: string;
  extensionVersion: string;
  queue: { queued: number; uploading: number; retrying: number; failed: number };
  sources: Record<string, {
    phase: "idle" | "running";
    paused?: boolean;
    lastErrorCode?: string;
    queued: number;
    uploading: number;
    retrying: number;
    failed: number;
  }>;
}
```

**Test first:**

- Accept a bounded valid heartbeat.
- Reject unknown schema versions, malformed installation IDs, invalid semantic-version strings, negative/non-integer counts, unknown source names, unknown phases, excess keys, and oversized strings.
- Validation errors never echo the payload or credential-shaped values.
- The validated result contains no URL, token, raw, cookie, session, or provider-header field.

**Implement:**

- Export the envelope, source-state type, and `parseExtensionHeartbeat` validator.
- Allow only the current extension sources plus `web`; planned GitHub is not emitted before implementation.
- Bound source count and all strings.

**Verify:**

```powershell
bun test packages/sources/src/extension-heartbeat.test.ts
bun run typecheck
```

**Suggested commit:** `feat(sources): define extension heartbeat contract`

### Task 2.2: Persist and aggregate extension clients

**Create:**

- `packages/db/src/extension-health.ts`
- `packages/db/src/extension-health.test.ts`

**Modify:**

- `packages/db/src/schema.ts`
- `packages/db/src/index.ts`
- The Phase 1 migration before it is committed, or generate a separate additive migration if Phase 1 has already landed

**Schema:**

- `installation_id` primary key.
- `extension_version`.
- `last_seen_at`, assigned by the server.
- JSON queue snapshot.
- JSON per-source snapshot.

**Test first:**

- First heartbeat inserts a client; later heartbeat updates the same row.
- Server time, not client time, controls `lastSeenAt`.
- No client yields `never_connected`.
- A heartbeat at or under five minutes yields `connected`.
- Older heartbeat yields `disconnected` with last-seen metadata.
- Multiple active clients aggregate queue totals without including expired clients.
- Latest source snapshot wins deterministically by `lastSeenAt`, then installation ID.

**Implement:**

- `recordExtensionHeartbeat(db, heartbeat, receivedAt)`.
- `extensionHealth(db, now, ttlSeconds = 300)`.
- JSON parsing must fail closed to an empty operational snapshot rather than crash the Sources route.

**Verify:**

```powershell
bun test packages/db/src/extension-health.test.ts
git diff --check -- packages/db
```

**Suggested commit:** `feat(db): persist extension heartbeat health`

### Task 2.3: Add the authenticated heartbeat route

**Modify:**

- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`

**Test first:**

- Missing, malformed, or wrong bearer token returns 401 and stores nothing.
- Invalid heartbeat returns 400 and stores nothing.
- Valid heartbeat returns a small acknowledgement and upserts the client.
- The response and logs do not echo installation payload details.
- Existing ingestion and source routes remain compatible.

**Implement:**

- Add `POST /api/extension/heartbeat`.
- Reuse the existing token verification boundary used by `/api/ingest` instead of creating a second credential.
- Validate with `parseExtensionHeartbeat`, assign server receipt time, delegate to the database module, and return `{ ok: true, receivedAt }`.

**Verify:**

```powershell
bun test apps/web/src/server/api.test.ts packages/db/src/extension-health.test.ts
```

**Suggested commit:** `feat(web): accept authenticated extension heartbeats`

## Phase 3: Extension heartbeat delivery

### Task 3.1: Build an isolated heartbeat client

**Create:**

- `apps/extension/lib/heartbeat.ts`
- `apps/extension/lib/heartbeat.test.ts`

**Test first:**

- Installation ID is created once and reused.
- Payload construction includes only version, aggregate queue counts, and bounded per-source operational state.
- Payload excludes settings tokens, server URLs, page URLs, raw data, status prose, handles, and captured item IDs.
- A successful send records the local last-success time.
- Network, authentication, and validation failures return sanitized diagnostics and do not mutate the capture queue.
- Concurrent triggers coalesce into one in-flight heartbeat.

**Implement:**

- Inject storage, version, clock, state-reader, and transport dependencies behind a small interface.
- Use `crypto.randomUUID()` for installation identity.
- Read the extension version from `browser.runtime.getManifest().version` at the background composition boundary.
- Post directly to the configured Anansi origin with the existing bearer token.
- Do not enqueue heartbeat requests in `CaptureQueue`.

**Verify:**

```powershell
bun test apps/extension/lib/heartbeat.test.ts
bun run --cwd apps/extension compile
```

**Suggested commit:** `feat(extension): add sanitized heartbeat client`

### Task 3.2: Trigger heartbeats from durable state changes

**Modify:**

- `apps/extension/entrypoints/background.ts`
- `apps/extension/lib/messages.ts`, only if the popup needs heartbeat diagnostic fields
- Relevant extension tests or integration harness

**Test first:**

- Startup/install schedules a heartbeat without delaying queue recovery.
- A two-minute alarm triggers a heartbeat.
- Run start, pause, finish, and failure request a coalesced heartbeat.
- Queue changes request a coalesced heartbeat.
- Heartbeat failure leaves capture delivery and run state untouched.
- Service-worker restart reconstructs the heartbeat module from persisted installation identity.

**Implement:**

- Add a dedicated heartbeat alarm name and two-minute period.
- Compose the module from existing durable queue and source-run snapshots.
- Trigger asynchronously after material state changes; never await it on a platform event's critical capture path.
- Keep heartbeat diagnostics separate from source-capture diagnostics.

**Verify:**

```powershell
bun test apps/extension/lib/heartbeat.test.ts apps/extension/test/sync.integration.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

**Suggested commit:** `feat(extension): report durable capture health`

## Phase 4: Server-owned source catalogue

### Task 4.1: Return every product source at zero items

**Create:**

- `apps/web/src/server/source-catalog.ts`
- `apps/web/src/server/source-catalog.test.ts`

**Modify:**

- `apps/web/src/server/api.ts`
- `apps/web/src/server/api.test.ts`
- `apps/web/src/lib/api.ts`

**Test first:**

- Empty database returns X, Reddit, TikTok, Web, and GitHub cards.
- X and Reddit are supported; TikTok is experimental; GitHub is coming next; Web is manual.
- GitHub cannot be toggled while planned.
- Disabled supported sources remain visible.
- Item statistics and explicit provenance counts join onto the right catalogue entry.
- The response includes extension health and per-source operational snapshots.

**Implement:**

- Move source metadata to one server catalogue instead of duplicating it in the React route.
- Left-join catalogue rows with `sourceHealth`, source settings, and `extensionHealth`.
- Preserve current source-toggle endpoint for supported sources; reject planned or unknown sources.
- Return stable response types consumed by the web app.

**Verify:**

```powershell
bun test apps/web/src/server/source-catalog.test.ts apps/web/src/server/api.test.ts
```

**Suggested commit:** `feat(web): serve complete source catalogue`

## Phase 5: Truthful Sources UI

### Task 5.1: Extract pure source-state presentation

**Create:**

- `apps/web/src/lib/source-state.ts`
- `apps/web/src/lib/source-state.test.ts`

**Test first:**

- State precedence is: coming next, disabled, disconnected, running, paused, failed, retrying, queued, experimental, ready.
- Failed or queued state can never render ready.
- A recent item without a heartbeat renders disconnected.
- Manual Web capture does not require an always-connected platform observer to describe its capability.
- Actions are real for the state: enable/disable, import, pause, resume, retry, sign in, view, or open.

**Implement:**

- Add a pure mapping from API records to card labels, tone, counts, and actions.
- Keep relative-time formatting separately testable.
- Remove `healthy` and `stale` terminology from the presentation contract.

**Verify:**

```powershell
bun test apps/web/src/lib/source-state.test.ts
```

**Suggested commit:** `feat(web): derive truthful source presentation state`

### Task 5.2: Rebuild the Sources page around server truth

**Modify:**

- `apps/web/src/routes/sources.tsx`
- `apps/web/src/components/skeleton.tsx`, only after reconciling the pre-existing GitHub-card diff
- `apps/web/src/lib/api.ts`

**Optional create:**

- `apps/web/src/components/source-card.tsx` if extracting the current large local component materially improves isolation
- Focused React tests using the repository's existing Testing Library setup

**UI requirements:**

- Top banner: Connected with version, Disconnected with last seen, or Never connected.
- Every catalogue source renders with zero items.
- Cards show total and explicit live/imported/manual/Chrome/historical counts.
- Last capture comes from successful capture events, not item saved time.
- TikTok visibly says experimental.
- GitHub visibly says coming next and has no working toggle.
- Existing Hide removed setting remains unchanged.
- Existing source icons and colours are reused.

**Test first:**

- Empty-library rendering.
- Connected, disconnected, and never-connected banners.
- Failed, paused, queued, experimental, and planned cards.
- Legacy count rendering without relabelling it as imported.
- Toggle and filtered-library links only where supported.

**Verify:**

```powershell
bun test apps/web/src/lib/source-state.test.ts apps/web/src/server/api.test.ts
bun run --cwd apps/web build
```

Run React Doctor after React changes and report unrelated pre-existing warnings separately.

**Suggested commit:** `feat(web): show truthful extension and source health`

## Phase 6: Integrated verification and handoff

### Task 6.1: Migrate a disposable database and exercise the flow

**Steps:**

1. Apply migrations only to a disposable test database.
2. Verify existing items become `legacy_unknown` and remain searchable.
3. Post a valid heartbeat and verify `/api/sources` becomes connected.
4. Advance the test clock or fixture past five minutes and verify disconnected.
5. Insert representative captures for every provenance method and verify counts.
6. Confirm the empty-database catalogue renders without indefinite skeletons.

### Task 6.2: Full scoped validation

**Run:**

```powershell
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
git diff --check
```

Run React Doctor for the React changes. Browser-check the Sources page at a desktop width and at 320px or the narrowest supported layout. Verify Connected, Disconnected, Never connected, zero-item, failed, experimental, and coming-next states.

Inspect `git status --short` before every commit. Commit only files belonging to the current task, leaving the pre-existing GitHub-card work untouched unless a reviewed overlapping hunk is required by this implementation.

### Task 6.3: Completion report

Report separately:

- Automated tests, builds, type checks, diff checks, and React Doctor results.
- Local heartbeat and browser evidence.
- Any pre-existing failures or warnings.
- The unchanged authenticated-provider acceptance gap.
- Remaining GitHub extension work, which begins only after this implementation is accepted.

## Final acceptance checklist

- [ ] Empty libraries return and render all catalogue sources.
- [ ] Extension connection is based on a server-received heartbeat no older than five minutes.
- [ ] Extension version and last seen are visible.
- [ ] Heartbeat failures cannot block capture or upload.
- [ ] Heartbeat payloads contain no credentials, URLs, raw saves, or provider data.
- [ ] First-arrival provenance is explicit and immutable.
- [ ] Legacy data is labelled historical/unknown rather than guessed.
- [ ] Source cards never derive health from item age.
- [ ] Outstanding queue/run failures outrank reassuring states.
- [ ] TikTok is experimental and GitHub is coming next.
- [ ] Existing unsave retention and Hide removed behavior remain intact.
- [ ] Existing dirty GitHub-card work is preserved and not accidentally committed.
