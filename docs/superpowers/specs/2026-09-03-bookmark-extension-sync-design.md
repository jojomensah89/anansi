# Anansi Reliable Bookmark Capture and Sync Design

**Date:** 2026-09-03
**Status:** Approved design
**Scope:** Browser extension capture, durable delivery, local ingestion, and web-library synchronization for X, Reddit, TikTok, generic webpages, and Chrome bookmarks

## 1. Purpose

Anansi should reliably turn an explicit save made in a supported browser context into an item in the user's local SQLite library and web UI. A browser restart, a sleeping Manifest V3 worker, a temporarily unavailable local server, or a repeated platform event must not silently lose or duplicate the save.

The extension should support five independent capture paths:

1. X bookmarks.
2. Reddit saved posts and comments.
3. TikTok Favorites.
4. Explicitly saving the current webpage from the toolbar or context menu.
5. Optional mirroring of native Chrome bookmarks.

Anansi remains local-first: SQLite is the canonical library. Extension IndexedDB is a durable delivery outbox and resumable-sync store, not a second canonical bookmark database.

## 2. Evidence and research boundary

This design combines public product documentation, open-source implementations, Chrome extension documentation, and inspection of the current Anansi repository.

Public evidence establishes patterns, not the private source code of [removed] or [removed]:

- [[removed]: How saving works]([source removed]) describes native platform saves, local queueing, retries, visible failures, and short-term retention of unsent captures.
- [[removed]: Importing your saves]([source removed]) describes using the user's signed-in browser session, platform requests, pagination, resumable imports, deduplication, and stopping after already-known items.
- [[removed]: Saving from X]([source removed]) and [Saving from TikTok]([source removed]) document the user-facing source behavior.
- [[removed] privacy]([source removed]) describes extension-local queue/sign-in state and fixed supported-site access. It does not establish that [removed] copies platform cookies.
- [[removed] privacy]([source removed]) states that its extension keeps canonical data in local IndexedDB and intercepts X bookmark responses. Anansi deliberately adopts response interception but keeps SQLite canonical.
- [[removed] bookmark features]([source removed]) provides product-level behavior for bookmark capture and organization.
- [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) establishes that global variables and ordinary timers are not durable across worker termination.
- [Chrome cookies API](https://developer.chrome.com/docs/extensions/reference/api/cookies) confirms that explicit cookie permissions are needed to query or mutate cookies. Anansi does not need this capability.
- The open-source [X Post Archive interceptor](https://github.com/FUMIHITO-EGUCHI/x-post-archive-extension/blob/bda1ca30fadccc00e0d8cc81f6cae870c709cff9/src/features/x/intercept-like-bookmark-actions.ts) demonstrates extracting bookmark mutation identifiers and validating responses.
- The open-source [TikTok Saver architecture](https://github.com/josephdecker1/tiktok-saver/blob/f26caacdad0d9926d4504fc60cb4eb3dbdbcbb01/ARCHITECTURE.md) distinguishes TikTok Favorites (`/api/user/collect/item_list/`) from Likes (`/api/favorite/item_list`) and recommends response interception over DOM scraping.
- The open-source [Commonplace TikTok parser](https://github.com/s0shaheen/commonplace/blob/81f9cc666d5624d932ce532f5794ea5e1d491756/src/capture.js) corroborates the `itemList` response shape and documents the danger of retaining large raw payloads in extension storage.

Authenticated end-to-end behavior remains to be proven against current live X, Reddit, and TikTok accounts during implementation acceptance. Public pages and open-source examples cannot prove the exact current private implementation of either inspiration product.

## 3. Current Anansi implementation and diagnosed failures

The repository already has useful source parsers, a bearer-protected `/api/ingest` route, SQLite upserts, source content scripts, and a web library. Focused compile, build, and parser/API tests passed during the review. Those checks prove local code health, not authenticated live-platform capture.

The main reliability and behavior gaps are:

### 3.1 Transient delivery

`apps/extension/entrypoints/background.ts` uploads captures directly and uses process-global maps and timers for coordination. A Manifest V3 worker can terminate between capture and upload or before a timer fires. Pending work and coordination state are then lost.

The current message listener also starts asynchronous work without returning a lifetime-bearing response promise. Delivery is therefore not tied cleanly to the message event's lifetime.

### 3.2 No durable retry or receipt

Failed uploads update status but are not persisted as retryable jobs. The server does not accept a client event identifier or return a stable ingestion receipt, so exactly-once event handling cannot be distinguished from an item upsert that happened to be idempotent.

### 3.3 X capture is brittle

`apps/extension/entrypoints/x-main.content.ts` notices both `CreateBookmark` and `DeleteBookmark`, but emits a generic saved signal rather than a precise save/unsave event with the mutation's tweet ID. Its import flow discovers a query ID from loaded webpack chunks, reads the JavaScript-visible `ct0` CSRF value, and reconstructs a request with an empty `features` object. That reconstruction can drift when X changes its GraphQL request contract.

The background logic can also select an arbitrary matching X tab. A normal home tab may not have loaded the Bookmarks query chunk.

### 3.4 Reddit lacks precise unsave semantics

`apps/extension/entrypoints/reddit.content.ts` correctly relies on same-origin authenticated requests to discover the current user and read `/user/{name}/saved.json`. However, `apps/extension/entrypoints/reddit-main.content.ts` treats `/api/save` and `/api/unsave` as equivalent refresh signals. The current model does not record that an item was removed from the source.

### 3.5 TikTok is not anchored to Favorites

The current configuration watches `/api/user/collect/item_list`, `/api/favorite/item_list`, and `/api/user/favorite/item_list`. TikTok's collected-item endpoint represents Favorites, while `/api/favorite/item_list` represents Likes. Treating both as bookmarks mixes different user actions.

The extension opens TikTok's root page and scrolls it. That does not guarantee that the Favorites route or its collected-item response will load. It also does not observe a successful favorite-button mutation, so saving from a feed may not sync until a later Favorites import.

### 3.6 Generic web and Chrome bookmarks are absent

The manifest deliberately avoids unrestricted website access, but there is currently no explicit active-page capture path and no optional native Chrome bookmark listener.

### 3.7 Ordering and pagination can become inconsistent

The Reddit and TikTok parsers derive `saveOrder` from a fresh request-level `importedAt`. Later-imported older pages can therefore sort ahead of earlier pages. Saved-order keyset pagination compares only `save_order`, excludes null rows after a numeric cursor, and lacks a deterministic item-ID tie-breaker.

### 3.8 Relay trust is too broad

The isolated relay forwards same-window messages based largely on an `anansi` marker, and the background trusts source labels in forwarded payloads. The seam needs sender/source validation, message schemas, size limits, and a per-install or per-session nonce where page-world messages are unavoidable.

## 4. Chosen architecture

Three approaches were considered:

1. Patch direct uploads. This is smaller but cannot make transient worker memory reliable.
2. Add a durable extension outbox while keeping SQLite canonical. **Chosen.**
3. Make extension IndexedDB the canonical library and replicate to SQLite. This resembles [removed] but creates two authoritative stores and unnecessary conflict resolution.

The chosen flow is:

```text
Platform action / toolbar / Chrome bookmark
                    |
                    v
       Source adapter normalizes capture
                    |
                    v
        Durable IndexedDB capture queue
                    |
                    v
      Retryable idempotent HTTP adapter
                    |
                    v
          Local Anansi ingest module
                    |
                    v
             Canonical SQLite data
                    |
                    v
                 Web library
```

The queue is a deep module: platform adapters learn only how to submit a normalized capture. Persistence, retry scheduling, backoff, server receipts, dead-letter handling, and cleanup remain behind one small interface.

```ts
interface CaptureQueue {
  enqueue(capture: BookmarkCapture): Promise<EnqueueResult>;
  getStatus(): Promise<QueueStatus>;
  retry(eventId?: string): Promise<RetryResult>;
}
```

The production implementation uses IndexedDB and HTTP. Tests exercise the same interface with in-memory adapters for IndexedDB-equivalent storage, time, and transport. Internal adapters do not leak into platform callers.

## 5. Session and cookie model

The extension must not query, copy, persist, export, or write X, Reddit, or TikTok login cookies.

Platform requests run in the signed-in platform page. The browser attaches HttpOnly session cookies normally. Main-world interception observes only the relevant request/response metadata and bookmark data. X may require a JavaScript-visible CSRF token such as `ct0`; this is used transiently in the page and is never sent to Anansi or stored in the queue.

The only long-lived extension credential is the user's Anansi ingestion token. It must be scoped to ingestion, sent only to the configured Anansi origin, redacted from diagnostics, and never exposed to page-world code.

## 6. Capture contract

All source adapters produce the same versioned envelope:

```ts
interface BookmarkCapture {
  schemaVersion: 1;
  eventId: string;
  source: "x" | "reddit" | "tiktok" | "web";
  action: "save" | "unsave";
  externalId: string;
  canonicalUrl: string;
  observedAt: number;
  captureMethod:
    | "platform_event"
    | "platform_import"
    | "toolbar"
    | "context_menu"
    | "chrome_bookmark";
  normalizedItem: NormalizedItem;
  rawPayloadVersion?: string;
  sourceLink?: {
    kind: "chrome_bookmark";
    externalId: string;
  };
}
```

Invariants:

- `eventId` is generated once before persistence and remains stable across retries.
- `externalId` is the platform object identifier for social sources.
- Generic web items use a deterministic identifier derived from the canonical URL.
- `observedAt` represents when the source action was observed, not when the server imported it.
- Raw payloads are optional, bounded, stripped of credentials, and retained only long enough to diagnose or reparse a failed capture.
- An unsave never deletes the canonical item. It changes source state to not currently saved.

## 7. Platform adapters

### 7.1 X

Initial import:

1. Open or reuse a dedicated `https://x.com/i/bookmarks` tab.
2. Observe a successful Bookmarks timeline request generated by X and retain its request template in memory for the run.
3. Parse the response and pagination cursor.
4. Use the working template for subsequent pages rather than guessing feature flags.
5. Checkpoint only after the captured page is acknowledged by Anansi.

Ongoing capture:

- Observe successful `CreateBookmark` and `DeleteBookmark` mutations.
- Extract the tweet ID from the mutation variables/request body.
- Validate the mutation response before creating an event.
- Emit `save` or `unsave` explicitly.
- For a save, obtain the corresponding post from an observed response or a narrow refreshed first bookmark page.

If page interception misses requests generated by a platform service worker, a narrowly filtered `webRequest` adapter may be evaluated. It is not a default permission in this design and must be justified by authenticated acceptance evidence.

### 7.2 Reddit

Initial import:

1. Call `/api/me.json` in Reddit's signed-in page context.
2. Resolve the current username.
3. Paginate `/user/{username}/saved.json?limit=100&raw_json=1` with Reddit's `after` cursor.
4. Parse saved posts and comments.
5. Persist the cursor only after server acknowledgement.

Ongoing capture:

- Observe successful `/api/save` and `/api/unsave` requests.
- Extract the Reddit fullname from the request.
- Emit an explicit action.
- Fetch only the affected post/comment details or perform a coalesced first-page refresh.

### 7.3 TikTok

Initial import:

1. Open the signed-in user's Favorites/Collections view, not the TikTok root feed.
2. Observe TikTok's own successful `/api/user/collect/item_list/` request.
3. Parse `itemList` and the platform cursor.
4. Reuse observed, valid page requests or allow the page to load subsequent pages; do not synthesize signatures.
5. Exclude `/api/favorite/item_list` because it represents Likes.

Ongoing capture:

- Observe the successful favorite/collection mutation generated by the page.
- Extract the affected video identifier and action from the observed request.
- Obtain normalized video details from the response, a nearby item response, or a narrow Favorites refresh.

Because TikTok request signing and endpoint details are volatile, exact mutation matching must be confirmed with a current authenticated fixture before it becomes an acceptance requirement.

### 7.4 Explicit current-page capture

Toolbar and context-menu actions use `activeTab` plus `scripting`, granting temporary access only after the user invokes Anansi. The extractor captures:

- Original URL and canonical URL.
- Title and description.
- Open Graph/Twitter image metadata.
- Selected text, when invoked from a selection.
- Readable article text when extraction is safe and useful.
- Site name, favicon URL, and capture time.

This path supports GitHub and other ordinary webpages without broad `<all_urls>` host permission. Restricted browser pages such as `chrome://` display a clear unsupported-page message.

### 7.5 Optional Chrome bookmark mirroring

Chrome mirroring is disabled by default and requests the `bookmarks` permission only when enabled.

- An optional one-time import walks the bookmark tree.
- `onCreated`, `onChanged`, and `onRemoved` events update Anansi thereafter.
- URL/title are always available; rich page extraction happens only when the page is open and the user explicitly captures it.
- Each Chrome bookmark node is represented by a source link, so duplicate bookmarks in different folders do not collapse their presence state.
- Removing the last linked Chrome node marks the Anansi item as no longer saved in Chrome but does not delete it.

## 8. URL identity and deduplication

Social items are identified by `(source, externalId)`.

Generic webpages are identified by a conservative canonical URL:

- Normalize scheme/host casing and default ports.
- Remove fragments.
- Remove only known tracking parameters such as `utm_*`, `fbclid`, and `gclid`.
- Preserve unknown and application-significant query parameters.
- Respect a valid same-origin canonical link when it does not collapse the page to an unrelated location.

Toolbar and Chrome captures of the same canonical URL resolve to one item while preserving independent capture/source-link records.

## 9. Durable queue

The IndexedDB outbox stores:

```ts
interface OutboxRecord {
  eventId: string;
  capture: BookmarkCapture;
  payloadHash: string;
  status: "queued" | "uploading" | "retry_wait" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError?: SanitizedError;
}
```

Queue rules:

- Commit the record before attempting network delivery.
- Remove it only after a successful stable receipt.
- Recover records left in `uploading` after worker termination by returning them to `queued` on startup.
- Process serially per source, with a small global concurrency limit.
- Coalesce redundant refresh signals but never discard distinct mutation events.
- Retry network errors, timeouts, HTTP 408/425/429, and 5xx responses.
- Honor `Retry-After`; otherwise use bounded exponential backoff with jitter.
- Treat 400/401/403/413/422 as visible failures requiring configuration, sign-in, payload, or software correction.
- Enforce per-record and total storage limits. Strip raw responses first; never store media blobs.
- Wake on enqueue, startup, installation/update, a periodic alarm, connectivity return, and an explicit Retry/Sync action.

Ordinary `setTimeout` calls may be used for short in-awake coordination, but never as the only durable retry or status mechanism.

## 10. Ingestion and database contract

The existing raw-page `/api/ingest` request remains accepted during migration. A versioned envelope is added without breaking current CLI or extension callers.

```http
POST /api/ingest
Authorization: Bearer <anansi-ingest-token>
Idempotency-Key: <eventId>
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "eventId": "...",
  "source": "x",
  "action": "save",
  "externalId": "...",
  "canonicalUrl": "...",
  "observedAt": 1788390000,
  "captureMethod": "platform_event",
  "normalizedItem": {}
}
```

Stable response:

```json
{
  "eventId": "...",
  "itemId": "...",
  "outcome": "created"
}
```

`outcome` is one of `created`, `updated`, `duplicate`, or `ignored_stale`. Replaying an acknowledged `eventId` returns the same logical receipt.

Recommended relational additions:

```text
capture_events
  event_id unique
  source
  external_id
  action
  observed_at
  received_at
  outcome
  item_id

items
  existing fields...
  platform_saved
  removed_from_source_at
  last_source_event_at

item_source_links
  kind
  external_id
  item_id
  present
  observed_at
  unique(kind, external_id)
```

Application rules:

- Insert or resolve the event by `event_id` before applying item state.
- Upsert the item by `(source, external_id)` or canonical web identity.
- Apply save-state changes only when `observedAt >= last_source_event_at`.
- Record older delayed events but return `ignored_stale` rather than reversing newer state.
- Never hard-delete an item because a source bookmark was removed.
- Keep the ingestion token least-privileged and reject unsupported source/action combinations.

## 11. Ordering and resumable imports

`importedAt` is ingestion metadata, not source ordering.

- Use a platform-provided order key where trustworthy.
- Otherwise assign an import-run order that remains stable across all pages in that run.
- Use `(saveOrder, itemId)` as the deterministic saved-order cursor.
- Define explicit behavior for null `saveOrder` rows so pagination cannot permanently skip them.

Each source maintains durable sync state:

```text
source
run_id
mode: initial | incremental
cursor
known_boundary
pages_acknowledged
last_success_at
paused
```

Incremental import begins at the newest page and stops after a configurable stable overlap of already-known IDs. Initial import resumes from its last acknowledged cursor.

## 12. Permissions and security controls

Required extension permissions:

```text
storage
alarms
activeTab
scripting
contextMenus
```

Host permissions remain limited to supported platform origins and the configured local Anansi origin. `bookmarks` is optional and requested at the moment Chrome mirroring is enabled.

The design explicitly excludes:

- `cookies` permission.
- Broad `<all_urls>` host permission.
- Copying or storing platform sessions.
- Sending an Anansi token into page-world scripts.
- Treating arbitrary same-window messages as trusted captures.

Relay messages require a strict schema, expected origin/source pairing, bounded payload size, and a nonce established by the isolated content script. The background derives the effective source from the verified sender tab URL instead of trusting a page-provided label.

## 13. User-facing status and recovery

The popup reports each source independently:

```text
X          Synced - 2 minutes ago
Reddit     Sign-in required
TikTok     3 waiting to upload
Web        Ready
Chrome     Mirroring disabled
```

It also provides:

- Pending, retrying, and failed totals.
- The last successful synchronization time.
- A concise actionable error.
- Retry one and Retry all.
- Sync now and Pause import.
- Open the relevant sign-in or Favorites page.
- Sanitized diagnostic copy without credentials or raw sensitive fields.

Authentication failures pause that source rather than retrying forever. Server-offline events remain queued. The extension must never claim “synced” until the local server acknowledges every event included in that status.

## 14. Safe implementation sequence

1. **Contract and migration groundwork**
   - Add capture-event and source-state schema.
   - Add versioned envelope handling and stable receipts while retaining raw ingestion.
   - Add idempotency and stale-event tests.

2. **Durable queue module**
   - Add IndexedDB persistence, retry policy, alarms, recovery, and status.
   - Route existing parser output through the queue without changing platform capture yet.

3. **X adapter**
   - Use the dedicated Bookmarks page.
   - Capture precise create/delete mutation events.
   - Replace guessed GraphQL reconstruction with an observed request template.

4. **Reddit adapter**
   - Preserve the working saved-list import.
   - Add precise save/unsave events and post/comment handling.

5. **TikTok adapter**
   - Restrict import to collected Favorites.
   - Add an authenticated current-response fixture.
   - Add mutation-driven ongoing capture.

6. **Generic webpage capture**
   - Add toolbar/context-menu commands and conservative URL canonicalization.

7. **Chrome bookmark mirroring**
   - Add optional permission, initial import, event listeners, and source links.

8. **Retirement**
   - Remove the direct-upload path only after all adapters pass acceptance.

Each phase is independently feature-controlled. Exactly one path owns delivery for a given capture; feature flags must not dual-write the same event through old and new upload implementations.

## 15. Testing strategy

The queue module's interface is the primary test seam. Tests should assert observable outcomes rather than IndexedDB implementation details.

Required automated coverage:

- Queue survives simulated worker termination between persistence and upload.
- Startup recovers abandoned `uploading` records.
- Network, 429, 5xx, and `Retry-After` behavior.
- Permanent failures enter visible failed state.
- Duplicate `eventId` returns the same receipt and does not duplicate state.
- Delayed older save cannot reverse a newer unsave.
- Per-source serialization and refresh coalescing.
- Payload and total-storage limits.
- Token and cookie values never enter page messages, queue diagnostics, or logs.
- URL canonicalization preserves meaningful parameters.
- Duplicate Chrome nodes retain independent source-link presence.
- Pagination handles equal and null order values without omission.
- Existing raw ingestion remains compatible during migration.
- X, Reddit, and TikTok parsers use sanitized captured fixtures.

Required browser acceptance matrix:

| Scenario | X | Reddit | TikTok | Web | Chrome |
|---|---:|---:|---:|---:|---:|
| Initial import | Yes | Yes | Yes | N/A | Optional |
| New save appears in web UI | Yes | Yes | Yes | Yes | Yes |
| Unsave retained and marked | Yes | Yes | Yes | Manual | Yes |
| Local server offline then restored | Yes | Yes | Yes | Yes | Yes |
| Browser restart with pending event | Yes | Yes | Yes | Yes | Yes |
| Duplicate event produces one item | Yes | Yes | Yes | Yes | Yes |
| Sign-in missing gives actionable state | Yes | Yes | Yes | N/A | N/A |

Authenticated acceptance must verify the real network shapes current at implementation time. Local fixtures alone are insufficient proof for live platform support.

## 16. Acceptance criteria

The design is complete when implementation can demonstrate all of the following:

1. Saving an item on X, Reddit, or TikTok produces the correct Anansi item without reading or persisting platform cookies.
2. Explicit toolbar/context-menu capture saves an ordinary webpage without permanent host permission for that site.
3. Chrome mirroring is independently opt-in and functions after permission grant.
4. Every capture is committed durably before upload and remains recoverable until acknowledged.
5. Restarting the browser or terminating the worker does not lose a queued capture.
6. Replaying an event does not duplicate an item or reverse newer source state.
7. Unsaving preserves the local item and records that it is no longer saved at the source.
8. Initial imports resume and incremental imports stop at a known stable boundary.
9. The popup accurately distinguishes queued, retrying, failed, sign-in-required, and synchronized states.
10. SQLite and the web UI reflect every acknowledged capture without relying on extension memory as canonical state.
11. Existing raw ingest and unrelated application behavior remain operational throughout staged migration.

## 17. Non-goals

- Logging users into social platforms.
- Exporting, sharing, or synchronizing social login sessions.
- Scraping arbitrary browsing history.
- Background capture of every visited webpage.
- Downloading TikTok video files or other media blobs into extension storage.
- Making IndexedDB a second canonical library.
- Guaranteeing compatibility with future private platform changes without renewed authenticated verification.
