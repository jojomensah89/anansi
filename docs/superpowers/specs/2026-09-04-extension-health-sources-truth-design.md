# Extension health and Sources truth design

**Date:** 2026-09-04  
**Status:** Approved design  
**Scope:** Extension heartbeat, source catalogue, capture provenance, and truthful Sources-page status. GitHub capture is a separate follow-up.

## Goal

The Sources page must answer whether Anansi capture is working now. It must not infer extension connectivity or capture health from the date of the newest library item. Every supported source must remain visible with an accurate state even when it has no items.

This is the first of two independent implementations. This design fixes source truth and observability. The next design and implementation will add extension-based GitHub starred-repository capture.

## Evidence boundary

Public product documentation establishes a useful product contract: a Connections page reports extension status, per-platform toggles, live and imported counts, current import progress, failures, and recovery actions. It does not prove private implementation details or that every live import succeeds.

The current Anansi checkout already has a durable extension outbox, resumable source-run records, source-specific queue counts, server-owned source switches, and raw capture-event receipts. Those are the implementation foundation. The defect is how the web Sources page derives and communicates state.

Authenticated X, Reddit, and TikTok behavior remains a separate acceptance gate. Local tests and browser checks cannot prove current provider behavior.

## Considered approaches

### Server heartbeat — chosen

The extension periodically sends a small authenticated status snapshot to Anansi. The server stores it and the Sources page reads the latest durable state. This works across tabs, survives page reloads, supports multiple browser installations, and naturally becomes stale when a browser is closed.

### Browser-only extension bridge

The web page could ask the extension directly whether it is installed. This is immediate but works only while the library page is open, retains no history, and does not provide a reliable source of truth for later diagnosis.

### Hybrid heartbeat and direct bridge

Combining both gives immediate detection and durable history, but it adds a second protocol and more state reconciliation than the first version needs.

## Connection model

Add an `extension_clients` table keyed by a random installation identifier generated once and stored in extension-local storage. Each row contains:

- Installation ID.
- Extension version.
- Last heartbeat time, assigned by the server.
- Aggregate queue counts: queued, uploading, retrying, and failed.
- A bounded, sanitized per-source state snapshot.

The extension posts to `POST /api/extension/heartbeat` using the existing Anansi bearer token. The payload contains operational metadata only. It must never contain platform cookies, session values, raw capture payloads, saved URLs, Anansi tokens, or provider request headers.

Heartbeats are sent:

- At extension startup and installation/update.
- After a source run starts, pauses, completes, stalls, or fails.
- After material queue-state changes.
- Every two minutes while the browser allows the service worker to run.

The heartbeat is best-effort and does not enter the bookmark outbox. A failed heartbeat never blocks capture or upload. The next ordinary event or alarm retries it.

The web app considers the extension connected when any known installation has a heartbeat no more than five minutes old. Older installations are shown as disconnected with their last-seen time. With no stored installation, the state is `Never connected`. Multiple current installations are aggregated for connection state; their queue counts are summed and their latest per-source state is selected deterministically by heartbeat time.

## Source catalogue

The server owns one catalogue for every source the product can describe. `/api/sources` left-joins this catalogue with item statistics, source settings, and the latest extension snapshot instead of starting from rows present in `items`.

The first implementation returns:

- X — supported.
- Reddit — supported.
- TikTok — experimental until authenticated acceptance and durable delivery are complete.
- Web — supported manual capture, including Chrome bookmark mirroring.
- GitHub — coming next, without a working toggle or capture claim.

Instagram is outside this increment and must not be presented as live.

Every supported source gets a normal card at zero items. Server source settings continue to control whether extension capture is enabled. A disabled source remains visible. Planned sources cannot be enabled until their capture contract exists.

## Capture provenance

`saved_at_exact` describes timestamp precision, not how an item entered the library. It must no longer be used as a proxy for live versus imported counts.

Add immutable first-arrival provenance to items with these values:

- `platform_event`
- `platform_import`
- `toolbar`
- `context_menu`
- `chrome_bookmark`
- `legacy_unknown`

The method that first creates an item remains its origin. A later refresh, re-import, re-save, or metadata update does not move it between counters. Existing rows migrate to `legacy_unknown`; the migration does not guess from timestamp precision.

Persist `capture_method` on new `capture_events` rows for audit and operational queries. Raw-page parsing receives the capture method through its parse context, and item-event ingestion carries the method already present in the capture envelope. Upsert logic sets item origin only on insert and preserves the existing value on conflict.

The Sources API reports live, imported, manual, Chrome-bookmark, and legacy-unknown counts from explicit provenance. The UI may combine manual methods visually when appropriate, but the API keeps them distinct.

## Source and extension states

The top banner shows exactly one of:

- `Connected · v<version>` with the latest heartbeat time.
- `Disconnected · last seen <relative time>`.
- `Extension never connected` with setup guidance.

Per-source card state follows this precedence so reassuring text can never hide outstanding work:

1. Coming next.
2. Disabled.
3. Extension disconnected, for extension-dependent sources.
4. Importing or capturing.
5. Paused.
6. Failed.
7. Retrying.
8. Queued.
9. Experimental.
10. Ready.

`Last capture` comes from the latest successful capture event or explicit manual capture, not `items.saved_at`. Item age may still be shown as library information but cannot determine operational health.

The card exposes only actions that are real for the state: enable or disable, import, pause, resume, retry, sign in, view saved items, or open the source. The web page does not render decorative actions it cannot dispatch.

## Sources-page presentation

Each card shows:

- Source icon, name, support state, and capture toggle where available.
- Total saved count.
- Explicit provenance counts: live, imported, manual/Chrome where applicable, and historical/unknown.
- Current import or queue state.
- Last successful capture time.
- Relevant recovery action and a filtered-library link.

The page removes the current age-derived `healthy` and `stale` labels. `Experimental` is a capability state, not a health colour. GitHub reads `Coming next` until its separate extension implementation passes its acceptance gates.

The existing retained-unsave model stays unchanged: an unsave marks the item as removed from the source, and the user can hide removed items with the existing setting.

## Error handling and privacy

- Heartbeat authentication uses the existing least-privileged Anansi token.
- Payload validation rejects unknown source names, unbounded strings, invalid versions, negative counts, and unsupported states.
- Error messages are sent only after credential-shaped values and URL queries are removed.
- A heartbeat rejection is recorded locally as diagnostic status but never blocks or dead-letters a bookmark capture.
- The server assigns heartbeat receipt time; it does not trust the extension clock for connectivity expiry.
- Old extension-client rows may be retained for diagnosis but do not contribute to connected or queue totals after expiry.

## Component and module boundaries

- A focused extension heartbeat module owns installation identity, payload construction, scheduling, and transport.
- Existing outbox and source-run modules expose snapshots; they do not know about HTTP heartbeat endpoints.
- A database health module owns client upsert, active-client aggregation, source-catalogue joining, and provenance statistics.
- The API validates transport and delegates; it does not derive UI labels.
- A pure web presentation function maps the API state to labels, tones, and available actions.

These boundaries keep the heartbeat mechanism replaceable and make state precedence testable without a browser.

## Verification

Automated coverage must include:

- Installation ID generation and persistence.
- Heartbeat payload sanitization and bounds.
- Heartbeat authentication, validation, upsert, expiry, and multi-install aggregation.
- Heartbeat failure leaving capture and outbox state untouched.
- Provenance set on first insert and preserved on later imports or live events.
- Existing rows reported as `legacy_unknown` without guessing.
- Capture-event method persistence.
- The source catalogue returning zero-item supported and planned sources.
- State-precedence tests proving disconnected, failed, or queued states cannot render as ready.
- Sources-page states for connected, disconnected, never connected, disabled, importing, paused, failed, experimental, planned, zero-item, and legacy-data cases.

Repository verification includes focused tests, the full relevant extension/database/web test suites, production builds, type checks, `git diff --check`, and React Doctor after React changes. Browser checks cover desktop and narrow layouts plus a local heartbeat becoming connected and then expiring.

Authenticated X, Reddit, and TikTok capture remains outside this local proof and must be reported separately.

## Acceptance criteria

1. A fresh library shows all catalogue sources instead of an indefinite loading state.
2. The page never calls a source healthy because it merely has a recent item.
3. A current heartbeat shows the extension connected, including version and last-seen time.
4. A heartbeat older than five minutes shows disconnected without deleting capture data.
5. Failed, retrying, queued, running, paused, disabled, experimental, and planned states are distinguishable and actionable.
6. Live and imported counts come from explicit immutable provenance rather than timestamp precision.
7. Existing items appear under historical/unknown and are not guessed into another category.
8. Heartbeat failure cannot interrupt bookmark capture or durable upload.
9. No heartbeat contains platform credentials, raw saves, URLs, or tokens.
10. GitHub is described as coming next until its extension capture is actually implemented.
11. Existing retained-unsave behavior and unrelated library functionality remain intact.

## Out of scope

- GitHub Star/Unstar capture and Stars-list import.
- Instagram capture.
- Richer X, Reddit, TikTok, or web-content parsing.
- Direct browser-to-web extension messaging.
- Provider login or session management.
- Treating a sleeping browser as an error rather than a disconnected extension.
