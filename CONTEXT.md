# Anansi context

This is the short vocabulary map for the current implementation. It names the
durable boundaries that matter when changing capture, search, source imports,
or AI enrichment. The architecture index in
[`docs/architecture-index.md`](docs/architecture-index.md) is the navigation
map; the improvement guide remains the historical rationale and work-packet
record.

## Glossary

| Term | Meaning in this repository | Primary implementation names |
| --- | --- | --- |
| **Saved item** | One canonical persisted row in `items`, identified by `(source, externalId)`. It contains normalized searchable/display data and the original `raw` payload. Source state (`platformSaved`, `removedFromSourceAt`) and user state (`archivedAt`, `favorite`, `note`) are retained on the row rather than deleting it. | `items`, `NormalizedItem`, `itemKey`, `upsertItems` in [`packages/db/src/schema.ts`](packages/db/src/schema.ts), [`packages/sources/src/item.ts`](packages/sources/src/item.ts), and [`packages/db/src/queries.ts`](packages/db/src/queries.ts) |
| **Capture** | A versioned event crossing the extension/server boundary. `BookmarkCapture` is either a `RawPageCapture` (a source page to parse) or an `ItemEventCapture` (save/unsave for one external identity). It is input to capture application, not itself a saved item. | `BookmarkCapture`, `RawPageCapture`, `ItemEventCapture`, `parseBookmarkCapture` in [`packages/sources/src/capture.ts`](packages/sources/src/capture.ts) |
| **Capture receipt** | The durable acknowledgement for one capture event. `applyCapture` writes the item/source transition and its idempotency record atomically; replaying the same `eventId` returns the first receipt. The queue accepts only a receipt for the event it delivered. | `CaptureReceipt`, `capture_events`, `applyCapture`, `createCaptureQueue` in [`packages/sources/src/capture.ts`](packages/sources/src/capture.ts), [`packages/db/src/capture-events.ts`](packages/db/src/capture-events.ts), and [`apps/extension/lib/capture-queue.ts`](apps/extension/lib/capture-queue.ts) |
| **Source import** | A persisted, resumable walk of a provider's saved/history surface. The shared lifecycle owns run identity, cursor acknowledgement, completion/cancellation/failure, and browser effects; the host still owns message validation and concrete tabs/alarms. `full` and `live` are distinct modes. | `SourceImportMode`, `createSourceImportLifecycle`, `SourceImportOutcome`, `SourceRuns` in [`apps/extension/lib/source-import-lifecycle.ts`](apps/extension/lib/source-import-lifecycle.ts) and [`apps/extension/lib/source-runs.ts`](apps/extension/lib/source-runs.ts) |
| **Source capability** | The canonical, shared description of what a source can do across independent dimensions: retained parsing/storage, product visibility, import mechanism, live capture, manual capture, toggling, and permitted capture methods. `SourceCapability` rows derive narrow views instead of collapsing everything into one `supported` flag. | `SOURCE_CAPABILITIES`, `SourceCapability`, `SOURCE_IDS`, `RETAINED_PARSING_SOURCES`, `VISIBLE_LIBRARY_SOURCES`, `EXTENSION_PLATFORM_SOURCES`, `PAGE_IMPORT_SOURCES`, `SESSION_IMPORT_SOURCES`, `LIVE_CAPTURE_SOURCES`, `MANUAL_CAPTURE_SOURCES`, `TOGGLEABLE_SOURCES`, and `SHIPPED_CAPTURE_SOURCES` in [`packages/sources/src/capabilities.ts`](packages/sources/src/capabilities.ts). Extension config is shared through [`packages/sources/src/extension-config.ts`](packages/sources/src/extension-config.ts); catalogue, background, popup, MCP, and database visibility consume those views. |
| **AI job** | One durable unit of AI enrichment for an item, qualified by kind (`embedding` or `tagging`), model generation, and content hash. Database functions own reconciliation, claim leases/tokens, retry/backoff, completion, and failure state. The shared runner claims a bounded batch and rechecks item, settings, model, and lease before publication. | `aiEnrichmentJobs`, `AiJob`, `reconcileAiJobs`, `claimAiJobs`, `completeAiJob`, `failAiJob`, `createAiJobRunner` in [`packages/db/src/ai-jobs.ts`](packages/db/src/ai-jobs.ts) and [`apps/web/src/server/ai-job-runner.ts`](apps/web/src/server/ai-job-runner.ts) |
| **Projection** | Derived state produced from a saved item, never a replacement for canonical item data. Current examples are AI tags (`itemTags`, applied through `applyAiTags`), canonical embedding metadata (`itemEmbeddings`, written through `upsertItemEmbedding`), remote Vectorize records, and local sidecar vectors. Search's shared card projection is a separate internal result-mapping concern. | `itemTags`, `itemEmbeddings`, `applyAiTags`, `upsertItemEmbedding`, `searchItemsPage`, `hydrateSearchItems` in [`packages/db/src/ai-jobs.ts`](packages/db/src/ai-jobs.ts) and [`packages/db/src/search.ts`](packages/db/src/search.ts) |
| **Index generation** | A model-scoped version of the local semantic sidecar. The sidecar stores `model` and an active random `generation` in `semantic_meta`; vector rows are keyed by `(generation, item_id)`. A model change creates a new generation and warms it independently while the canonical database remains authoritative. | `LocalSemanticCache.model`, `LocalSemanticCache.generation`, `replaceGeneration`, `semantic_meta`, `semantic_vectors` in [`apps/web/src/server/local-semantic-cache.ts`](apps/web/src/server/local-semantic-cache.ts) |

## Source-set shorthand

These views are intentionally not interchangeable even though they now derive
from one canonical capability table. In the current code:

- retained parser/storage identities are `x`, `github`, `reddit`, `tiktok`,
  and `web`;
- the current web source catalogue is `x`, `reddit`, `web`, and `github`;
- extension platform capture/import is `x`, `reddit`, and `github`; Web uses
  toolbar, context-menu, or Chrome-bookmark capture;
- page import is `x`; session import is `reddit` and `github`; live platform
  capture is `x`, `reddit`, and `github`; manual capture is `web`;
- MCP's optional source filter is the visible set `x`, `reddit`, `github`,
  and `web`;
- TikTok rows remain retained for repair but have no current capture methods,
  are excluded by the database visibility predicate, and are omitted from
  shipped product views.

The source-capability and shared extension-config packet landed in `31975d7`.
`parseExtensionConfig` is used by both the background host and popup, while
`visibleSourceClause` derives hidden membership from the same canonical facts.

## Evidence boundary

Local tests and builds establish contracts in this checkout. They do not prove
an authenticated provider session, a real Chrome MV3 lifecycle, Cloudflare D1,
Workers AI, Vectorize, or a running Ollama daemon. The release-readiness design
and runbook keep those acceptance gates explicit.
