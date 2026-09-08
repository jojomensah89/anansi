# Anansi architecture improvement guide

Date: 2026-09-07
Baseline: `25aed8d`
Status: implementation proposals based on source inspection; no refactors implemented by this document.

## Purpose and scope

This guide explores all four candidates from the validated architecture review and turns them into work packets. It supersedes the original HTML report's broad search coordinator and background-controller proposals. Proposed filenames and interface sketches below are recommendations, not existing contracts.

Anansi captures saved items into one private library. SQLite/D1 owns canonical content, identity, visibility, filters, and durable job state. The extension supplies browser sessions and durable capture delivery. Optional AI creates derived tags and vectors. HTTP, MCP, and CLI deliberately expose different experiences over shared library operations.

There is no `CONTEXT.md` or `docs/adr/` at this baseline. Relevant decisions are in the README and `docs/superpowers/specs/`, particularly the Cloudflare AI, Ollama semantic search, Ollama tagging, canonical topics, and background capture designs. Preserve those decisions when implementing this guide.

## Priority and implementation order

| Priority | Work packet | Assessment | Main outcome |
| --- | --- | --- | --- |
| 1 | Shared AI job execution | Strong | Three execution paths share lifecycle rules and tests |
| 2 | Source-import lifecycle | Worth exploring | Page and session imports share ownership, completion, and recovery |
| 3 | Source capability views | Worth exploring | Explicit source subsets replace repeated declarations |
| 4 | Internal search projection | Conditional | Common result fields stop drifting across retrieval paths |

Implement these as separate changes. Packets 2 and 3 overlap in extension code; give that file set one writer at a time. Packet 4 can be deferred if characterization finds no useful common projection beyond the existing helpers. File size alone is not evidence that a module is shallow.

## 1. Shared AI job execution

### Current implementation and friction

- `apps/web/src/worker.ts`, `runAiSchedule`: reconciles, claims, loads items, executes inference, persists projections, and completes or fails jobs.
- `apps/web/src/server/local-tagging-worker.ts`: repeats the lifecycle for tagging.
- `apps/web/src/server/local-semantic-worker.ts`: repeats it for embeddings and also repairs the sidecar, manages generations, and publishes local status.
- `packages/db/src/ai-jobs.ts`: already owns settings, reconciliation, claims, completion, backoff, and canonical topic application.
- `apps/web/src/server/ai.ts`: already defines `EmbeddingProvider`, `TagGenerationProvider`, and `VectorIndex`.

The lifecycle is scattered even though the durable job contract is shared. Hosted execution reads the full item table for each claimed job; local workers read it before processing their batches. Embedding metadata writes are duplicated between hosted and local execution. Local worker tests exercise real orchestration, but no direct hosted-schedule test was found in the inspected test files.

The deletion test supports a shared executor: deleting that executor after extraction would redistribute claim/load/execute/acknowledge/fail knowledge across three callers. The existing database job module is already valuable and should remain the authority for durable transitions.

### Target responsibilities

Create a server-side module such as `apps/web/src/server/ai-job-runner.ts`. Its interface should run a bounded batch for one kind with a supplied execution adapter and return an outcome summary. It owns item lookup, missing-item handling, claim lifecycle, failure classification, and acknowledgement ordering.

Keep these concerns elsewhere:

- SQL leases and backoff: `packages/db/src/ai-jobs.ts`.
- Inference formats and vector validation: provider adapters.
- Sidecar generation replacement, repair, and local health: local semantic worker/cache.
- Canonical tag suppression and manual provenance: database tag operations.
- Timers, cron invocation, and request nudges: runtime entrypoints.

Workers AI and Ollama are alternative embedding or tagging adapters. Vectorize and the SQLite sidecar satisfy vector-related responsibilities. Do not package each whole runtime into a single interchangeable adapter; inference, vector storage, and local repair vary independently.

An illustrative interface shape is a runner constructed with the database and an execution adapter, exposing `runOnce()` and returning claimed/completed/retrying/failed/skipped counts. Keep exact types provisional until both tagging and embedding callers compile against the first extraction. Avoid exposing a callback for every internal statement.

### Implementation steps

1. Characterize existing job outcomes through local worker tests and a new hosted execution test that does not import the TanStack server entry.
2. Extract hosted AI execution from `worker.ts` into a framework-independent module. Keep `worker.ts` responsible for binding construction and scheduling.
3. Add a database item lookup that selects only the claimed IDs. Keep sidecar-wide reconciliation scans separate from batch item loading.
4. Extract the common execution lifecycle and migrate local tagging first; its projection is simpler.
5. Migrate hosted tagging, then both embedding paths. Centralize the repeated embedding metadata write in the database package.
6. Retain local semantic repair and status publication around the runner. Do not make the shared runner depend on `bun:sqlite` or the sidecar implementation.
7. Replace tests of removed orchestration with outcome tests through the runner, retaining provider, SQL lease, sidecar, and suppression tests.

### Correctness work to resolve explicitly

The refactor must make the following cases reviewable. They are source-derived concerns, not claims that every failure has been reproduced:

- **Missing vector binding:** hosted code currently conditionally writes Vectorize but then writes complete metadata. Require a successful required projection write before completion, or leave embedding work unclaimed when the vector capability is unavailable.
- **Content changes during processing:** jobs carry a content hash while workers load current item text. Decide how stale jobs are detected before execution and before publishing results. A vector must not be labeled with an unrelated job hash.
- **Model changes:** reconciliation includes embedding model in job identity, but claims select by kind. Ensure an active execution adapter cannot claim another model's pending job and write it as current work.
- **Expired leases:** completion is token-conditional, but that alone does not fence tag or vector writes. Test overlapping workers and specify how stale results are prevented from replacing newer projections. Claim just in time or renew leases where bounded inference can outlive them; remote projection fencing may require generation/version metadata.
- **Batch lifetime:** claiming many jobs before sequential inference can exhaust later jobs' leases before they run. Test with an injected clock and slow adapters.
- **Quota and availability:** define what is a retry, a terminal failure, and a visible pause; use safe error codes rather than relying on provider response text.

Treat fixes to these behaviors as explicit follow-up commits with their own tests rather than burying them inside mechanical movement.

### Reconciliation scalability

The prior 500-row starvation bug is fixed at the baseline. `reconcileAiJobs` now scans the complete item and job tables and caps inserts. That cap bounds writes, not scanned rows, hashing, or memory.

After extracting the runner, measure reconciliation with a synthetic large library. If needed, add resumable keyset scanning with a stable tie-breaker and durable scan position. Complete a sweep and start another so edits behind the cursor are eventually revisited. Never restore an oldest-N prefix without progress state. Preserve the existing beyond-500 regression test and add interruption/resume and edits-behind-cursor cases. Normalize insert counts for both SQLite and D1 result shapes before relying on a count as the work budget.

### Acceptance criteria

- Disabled features make no inference calls and claim no new work.
- Failed projection writes do not yield completed jobs.
- Missing items, retries, lease expiry, model changes, and content changes have defined observable outcomes.
- Canonical topics preserve manual assignments and suppressions.
- Sidecar deletion and model changes still recover through the local semantic path.
- Hosted and local callers share one job lifecycle implementation.
- Search and ingest remain usable while AI is unavailable.

## 2. Source-import lifecycle

### Current implementation and friction

`apps/extension/entrypoints/background.ts` contains `startCapture`, `importWithoutTab`, page-event handling, owned-tab cleanup, recovery alarms, status publication, and cancellation. X imports arrive through page messaging; GitHub and Reddit imports execute through `runSessionImport`.

Several existing modules are already deep:

- `capture-queue.ts` owns durable delivery and retry.
- `source-runs.ts` owns durable run state, serialization, leases, and cursors.
- `session-import.ts` owns bounded session pagination and provider response validation.
- `messages.ts` validates message shape and provenance.

A generic extraction of all background code would mostly move complexity. The useful seam is the shared import lifecycle: starting and owning a run, accepting a page, advancing progress, completing, stopping, recovering, and cleaning up a run-owned tab.

### Target responsibilities

Introduce `apps/extension/lib/source-import-lifecycle.ts`. It coordinates the existing queue and run-state modules. Two real adapters justify the seam: X page import and GitHub/Reddit session import.

Conceptually, callers start or stop an import and deliver normalized lifecycle events carrying the source and run identity. The implementation accepts page/progress/completion/failure events only for the active run. Status and cleanup happen as consequences of those transitions.

Keep message authentication and sender validation in the browser host before events reach this interface. The lifecycle must not turn validated and unvalidated messages into the same trusted input.

### Implementation steps

1. Map transitions currently performed by `startCapture`, `importWithoutTab`, `handlePageEvent`, `finishRun`, and `expireOwnedRun`.
2. Write a transition table covering idle, active, paused/cancelled, limited, completed, and failed outcomes. Distinguish page-limit exhaustion from reaching the source's real end.
3. Extract completion, cancellation, and error handling first, using the existing `SourceRuns` interface.
4. Route session import callbacks through that lifecycle. Advance cursors only after durable page enqueue succeeds.
5. Route validated X page events through the same lifecycle, preserving run and tab identity checks.
6. Move recovery-alarm and owned-tab cleanup decisions into lifecycle outcomes; let the browser adapter perform the concrete alarm/tab operation.
7. Remove duplicate policy branches from the background host only after both import paths use the new module.

### Required invariants

- Only the current run may update its cursor, completion, or status.
- A late callback from an old run cannot finish a replacement run.
- A cursor advances only after the corresponding capture is durably queued.
- Stop preserves already queued captures and the acknowledged resume point.
- Live refresh does not overwrite the full-import resume cursor.
- Only tabs created and still owned by the run may be closed.
- Disabling a source stops further capture for that source while preserving history.
- Worker termination is recoverable from persisted state, not an in-memory timer.
- Pending saves that require fetched content remain ordered after the content captures.

### Tests and acceptance

Use an in-memory run store and controllable page/session adapters. Assert durable capture receipts, cursor state, status outcomes, and exact owned-tab cleanup requests. Cover cancellation during fetch, queue-full failure, stale completion, worker restart, repeated cursor, source disable, rate limit, live refresh during import, and page-limit exhaustion.

Keep existing queue, source-run, session-import, and message-validation tests. Add a small browser smoke for each real import adapter because fake tests do not prove browser session availability or platform behavior. The background host should register events and connect adapters; the lifecycle rules should be testable without loading the extension entrypoint.

## 3. Source capability views

### Current implementation and friction

Source identities and subsets occur in `packages/sources/src/item.ts`, `capture.ts`, `extension-heartbeat.ts`, extension messages/source runs, MCP input schemas, database visibility, the web source catalogue, ingest parser selection, and CLI adapter selection.

These are not all the same list. TikTok remains valid in retained parser/storage contracts but is hidden from the current product. Web capture is manual and supports bookmark mirroring; it is not a platform history import. GitHub/Reddit session import and X page import have different mechanisms.

The original report also mislabeled web, CLI, and ingest consumers as interchangeable adapters. They are consumers of capability views. Source-specific capture and parsing implementations are the adapters.

### Target responsibilities

Create a lightweight module such as `packages/sources/src/capabilities.ts` containing canonical identity and explicit capability facts. Derive narrow views for retained sources, visible library sources, extension platform sources, session-import sources, and permitted capture methods.

Keep the shared module free of browser globals, Bun imports, database drivers, credentials, and server runtime imports. Source-specific implementation registration should stay in the runtime that can safely import it. A shared metadata module should not drag every parser or CLI adapter into browser bundles.

A useful capability model has separate dimensions for retained parsing, product visibility, import mechanism, live capture, manual capture, and toggle behavior. Do not collapse these into one `supported` boolean. Keep display copy and provider endpoint details outside the model unless they truly share lifecycle and consumers.

### Implementation steps

1. Inventory all current source sets and record why each differs. Start with tests asserting today's exact sets.
2. Define canonical source identity once and derive TypeScript unions and validation sets where feasible.
3. Replace repeated product subsets with derived views, starting with source catalogues and extension configuration.
4. Preserve database visibility enforcement. UI omission alone cannot hide a retained source from direct search/detail/MCP access.
5. Move the extension configuration wire shape and validator to a shared, lightweight contract module. Use the same validator in popup and background config loading; currently the background casts a JSON response to `RemoteConfig`.
6. Keep parser and CLI construction switches if they remain clearer; validate their registrations against the capability model rather than introducing a universal plugin framework.
7. Verify extension build inclusion and permissions independently of runtime source lists.

### Tests and acceptance

- Retained TikTok payloads remain parseable and stored rows remain intact.
- TikTok remains absent from current list/search/detail/stats/MCP responses and shipped extension configuration.
- Web is available for manual capture without pretending to support a history walk.
- Session-import and page-import sets remain distinct.
- Unknown sources, invalid configuration, and inconsistent capability combinations are rejected.
- Both config consumers validate the same wire contract.
- Extension permissions and build discovery match the intended shipped sources.

This packet is worthwhile if it removes repeated decisions and creates useful invariant tests. Stop short of metadata fields with only hypothetical consumers.

## 4. Internal search projection

### Current implementation and friction

`packages/db/src/search.ts` already owns a deep search interface: FTS normalization, shared filter predicates, cursor validation, item visibility, and hydration. HTTP parameter parsing is an adapter. MCP's smaller keyword-only interface is deliberate. `semantic-search.ts` already coordinates optional rank fusion and fallback.

The narrower opportunity is duplicated SQL fields and result mapping in `searchItemsPage`, `hydrateSearchItems`, and `listItems`. JSON handling and quoted-media projection differ between paths. Some differences are intentional: lexical excerpts and scores come from FTS; list ordering uses bookmark or post chronology; semantic-only results need hydration in candidate order.

### Target responsibilities

Deepen the existing database search implementation with private projection fragments and hydration functions where fields actually match. Keep the public query methods and transport behavior stable. A possible internal `search-projection.ts` is justified only if it improves navigation; it need not be exported from the package.

### Implementation steps

1. Create characterization fixtures containing quoted media, missing media, malformed decoration JSON, manual tags, canonical topics, notes, favorites, archived/removed items, and hidden sources.
2. Record the intended result shape for each retrieval path. Identify accidental inconsistencies separately from product differences.
3. Extract common SQL projection fragments using bound SQL expressions; keep FTS excerpt/score and ordering fields in their respective queries.
4. Extract common safe decoration hydration. Preserve quote-media separation wherever that is the agreed result contract.
5. Preserve distinct cursor construction and ordering rules. Keep semantic first-page fallback and pagination behavior unchanged during extraction.
6. Compare query counts and timing on a synthetic corpus; avoid replacing one projected query with per-item hydration requests.

### Tests and acceptance

- Shared card fields agree across matching items in list, lexical, and semantic hydration results.
- Excerpts, scores, order, and cursors retain their intended mode-specific behavior.
- Malformed decoration data does not unexpectedly remove an otherwise valid item.
- Visibility, repeated filters, archived/removed/favorite predicates, and cursor rejection remain covered.
- MCP remains keyword-based and keeps its existing bounded output.
- No new public search coordinator or generic query framework is necessary.

## Delivery, verification, and rollback

For every packet, record the source baseline, characterize behavior first, move one caller at a time, and review the final diff for scope. Use synthetic databases and provider responses for automated checks. Avoid production captures or credentials in fixtures.

Relevant existing suites include `packages/db/src/ai-jobs.test.ts`, local semantic/tagging worker tests, `apps/web/src/server/api.test.ts`, extension source-run/session-import/queue/message tests, database filter/pagination/preservation/search tests, and MCP tool tests.

Run focused tests during development, then `bun test`, `bun run typecheck`, `bun run --cwd apps/extension compile`, relevant production builds, and `git diff --check` before merging a packet. Use the existing synthetic Ollama and local acceptance scripts when an AI runtime path changes. Hosted binding behavior requires its own acceptance; a local fake or successful build does not prove it.

Prefer refactors without schema changes. If a later correctness fix introduces job generations or reconciliation cursors, use additive migrations, specify compatibility with old workers, and preserve existing data. A simple code revert is not a complete rollback for incompatible durable state changes. Document the rollback per packet before release.

## Suggested issue breakdown

1. Characterize AI execution and extract hosted execution from the framework entrypoint.
2. Introduce shared job runner and migrate tagging callers.
3. Migrate embedding callers and centralize metadata writes.
4. Resolve stale job/model/lease projection cases with explicit tests.
5. Measure and, if necessary, implement resumable reconciliation.
6. Characterize import transitions and extract source-import lifecycle.
7. Migrate session and page import adapters; verify restart and cancellation.
8. Introduce source capability views and shared extension config validation.
9. Characterize search result differences; consolidate justified internal projection.

## Documentation to update as implementation lands

- Add a short `CONTEXT.md` glossary for Saved item, Capture, Capture receipt, Source import, Source capability, AI job, Projection, and Index generation, using names agreed during implementation.
- Add ADRs only for durable choices: shared AI lifecycle with separate projection adapters; retained versus shipped source subsets; database-owned filtering and visibility; keyword-only MCP unless explicitly changed.
- Add an architecture index linking this guide, accepted ADRs, current design specs, and runtime entrypoints.
- Update README setup or behavior statements only when the implementation changes those facts.
- Mark superseded design sections explicitly rather than leaving contradictory instructions for future work.
- For each completed packet, record tests run, remaining provider/browser acceptance, and the commit that implements it.

The first concrete implementation target is the common AI job lifecycle. Its completion should make all three callers easier to test while leaving local sidecar repair and source-specific execution in their existing homes.
