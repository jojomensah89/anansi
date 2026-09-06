# Cloudflare AI Enrichment and TikTok Retirement Design

**Date:** 2026-09-06  
**Status:** Approved for planning  
**Scope:** Self-hosted Cloudflare deployment, optional semantic search and automatic AI tags, and temporary removal of TikTok from all shipped/user-visible surfaces.

## 1. Product decisions

Anansi is self-hosted: each installation has one private library in the user's own Cloudflare account. There is no shared multi-tenant control plane. The deployment must therefore provision its own resources and work with minimal manual configuration.

The default hosted installation remains useful without AI:

- BM25/FTS5 keyword search continues to work.
- Manual tags remain available.
- No Workers AI inference or Vectorize writes happen until the user enables them.

AI capabilities are independently opt-in:

- **Semantic search** enables query and item embeddings plus hybrid ranking.
- **Automatic tags** enables model-generated tags on new and changed items and a paced backfill.

When automatic tags are enabled, the system applies accepted model output automatically. Automatic application is non-destructive: manual tags are never overwritten, and a manual deletion/rename suppresses the corresponding AI suggestion for that item.

TikTok is retired from the product surface until its authenticated capture path is repaired. Existing TikTok rows are retained for possible future migration/re-enablement but are hidden from all current user-facing views and API paths. No destructive data deletion is part of this work.

## 2. Cloudflare architecture

### 2.1 Resources

The Alchemy stack provisions the following resources in every hosted deployment:

- Existing Worker, D1 database, and R2 bucket.
- One Workers AI binding (`AI`).
- One Vectorize V2 index bound to the Worker (`VECTORIZE`), using the `@cf/baai/bge-small-en-v1.5` preset, 384 dimensions, and cosine similarity.
- The existing five-minute Cron Trigger, extended to process AI jobs as well as media recovery.

Creating the AI binding and an empty Vectorize index does not run inference or store vectors. Feature flags in D1 are the runtime gate, so an installation that never opts in incurs no model calls or vector writes. A deployment that cannot provision or bind AI resources must still start with keyword search and manual tags available; the UI should report AI as unavailable rather than blocking the library.

The current Cloudflare documentation lists 10,000 Workers AI neurons per day on Workers Free, 5 million stored Vectorize dimensions, and 30 million queried Vectorize dimensions per month. The 384-dimensional model leaves room for approximately 13,000 vectors before the stored-dimension allowance is reached, but the implementation must pace jobs and surface quota/capacity errors rather than promise a fixed throughput. See [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), and [the embedding model documentation](https://developers.cloudflare.com/workers-ai/models/).

### 2.2 D1 settings and job state

Add a singleton `ai_settings` row (or equivalent installation-settings record) containing:

- `semantic_search_enabled`
- `auto_tagging_enabled`
- `embedding_model` and `embedding_dimensions`
- `tag_model`
- `updated_at`
- optional local daily job budget and last quota pause reason

Add durable enrichment state, following the existing media-job lease pattern:

- `ai_enrichment_jobs`: item ID, job kind (`embedding` or `tagging`), content hash, status, attempts, `next_run_at`, `lease_until`, claim token, and bounded error text.
- `item_embeddings`: item ID, Vectorize ID, model, dimensions, content hash, status, and timestamps.
- `item_tag_overrides`: item ID, tag ID, override (`suppressed` or `manual`), and timestamp. A suppressed AI tag must not be re-added for the same item unless the user explicitly re-adds it or clears the override.
- Extend `item_tags` with per-assignment provenance (`manual` or `ai`), model/version, and applied timestamp. The existing `tags.origin` remains the creation-level hint; assignment provenance is authoritative for suppression behavior.

All job and vector writes are idempotent. A content hash of the canonical searchable text prevents repeated work on unchanged items. Vector IDs are stable item IDs; upserting a changed embedding replaces the prior vector.

### 2.3 Canonical embedding input

Embed the normalized searchable representation already used by the library: title, body/excerpt, article text where available, and author context. Normalize whitespace and cap the input before calling Workers AI. Do not embed raw platform payloads, private notes, media URLs, or credentials. The same canonical input/hash is used for both local and hosted job tests.

### 2.4 Job flow and free-tier controls

1. Ingest/upsert makes an item eligible for enrichment. A reconciliation step inserts missing jobs for enabled features, so every ingest path remains covered without coupling database writes to a remote model call.
2. The Cron Trigger claims a small bounded batch using a lease and processes it sequentially or with a small concurrency cap.
3. Embedding jobs call Workers AI, then upsert the vector and mark `item_embeddings` complete.
4. Tagging jobs call the configured small text-generation model, parse a strict JSON response, normalize labels, apply at most 3–5 tags, and record assignment provenance.
5. Success deletes/marks the job complete. Failures use bounded exponential backoff. Repeated 403/429/out-of-capacity responses pause the relevant feature and show the reason in Settings; they do not fail ingest or keyword search.
6. Disabling a feature stops new claims. Existing vectors and AI tags remain intact but are ignored by disabled search/tag paths; re-enabling resumes from durable state.

The worker must never attempt an unbounded backfill in one request. The local budget is conservative and observable, while Cloudflare's actual quota remains authoritative. The existing Workers Free limits include 100,000 requests/day and five Cron Triggers per account; this design uses one Cron Trigger and small batches. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### 2.5 Automatic tag policy

The model receives bounded item text and a short instruction to return a JSON array of concise topic labels. The parser rejects malformed output, labels longer than the configured maximum, control characters, duplicates, and an excessive number of labels. It does not allow model output to modify item text, notes, favorites, archive state, or manual tags.

If a label already exists as a manual tag, the assignment is treated as already satisfied and the manual tag remains authoritative. If the user deletes an AI assignment, `item_tag_overrides` suppresses that item/tag pair. An explicit manual re-add clears the suppression and records a manual assignment.

### 2.6 Hybrid search

When semantic search is enabled and the AI binding is healthy:

1. Embed the query with the same embedding model.
2. Retrieve a bounded candidate set from Vectorize (IDs and scores only).
3. Retrieve the bounded BM25 candidate set from FTS5.
4. Merge candidates with deterministic reciprocal-rank fusion, using the item ID as the tie-breaker.
5. Fetch authoritative item rows and apply source, author, tag, media, archive, and removed-state filters in D1.
6. Return the existing `SearchHit` shape and a cursor encoding query/filter identity plus the hybrid rank key.

If query embedding, Vectorize, or model capacity fails, return BM25 results and a non-blocking degraded-search status. Exact filters and item visibility always remain D1-owned; Vectorize is only a candidate/ranking service.

## 3. Settings and deployment UX

Add an AI section to the web settings surface with two independent toggles, status text, and bounded progress:

- Semantic search: off, indexing, ready, paused, or unavailable.
- Automatic tags: off, processing, ready, paused, or unavailable.

The screen must explain that enabling AI uses the user's own Cloudflare quota and that disabling it does not delete existing tags or vectors. It should show the last successful run, pending count, and the most recent bounded error when available.

`bun run deploy` remains the intended first-run command. It provisions bindings, applies migrations, and leaves both toggles off. There must be no requirement for the user to manually create a Vectorize index, copy an index name, or enter a provider API key.

Local development has no Vectorize emulator requirement. When bindings are absent, AI endpoints report disabled/unavailable and the rest of the application works normally. Tests inject fake AI and Vectorize implementations.

## 4. TikTok retirement boundary

Remove TikTok from the shipped extension runtime:

- Do not build the TikTok content entrypoint; archive it outside WXT's entrypoint discovery so the adapter remains available for later repair.
- Remove TikTok host permissions and relay/content-script matches.
- Remove TikTok from popup source rows, source-run scheduling, background import/capture branches, and popup connection validation.
- Keep the parser, sanitized fixtures, and focused platform tests in repository code for future reactivation.

Remove TikTok from the web product surface:

- Omit it from `SOURCE_CATALOG`, source cards, source filters, sidebar source links, creators/source labels, source marks where they are user-selectable, and source health responses.
- Add a shared hidden-source predicate at the database/API boundary so direct `source=tiktok` queries, counts, creators, recent saves, item detail, and MCP search cannot surface it.
- Retain rows in D1 and avoid deleting media or tags. Re-enabling later should be a deliberate code/config change, not an accidental appearance caused by old data.
- Update README and current source documentation to describe TikTok as paused/retained for repair rather than supported or selectable.

## 5. Error handling and safety

- AI failures are isolated from ingest, manual tagging, BM25 search, MCP, and media recovery.
- Job claims use conditional lease updates; expired workers cannot acknowledge a newer claim.
- All model output is treated as untrusted data and normalized before D1 writes.
- Search never trusts Vectorize metadata for authorization or exact filtering.
- No platform cookies, signing values, raw payloads, or private notes are sent to model calls.
- Resource-provisioning or binding failures are visible in deployment output and Settings, but do not make the non-AI library unusable.

## 6. Verification and acceptance gates

### TikTok

- Extension compile/build output contains no TikTok content script or TikTok host permission.
- Popup and web source lists contain X, Reddit, GitHub, and Web only.
- `/api/sources`, stats, search, recent, creators, item detail, and MCP search cannot return TikTok rows.
- Existing TikTok rows remain in the database and are not deleted.
- Parser/platform fixture tests remain green for future repair.

### AI settings and jobs

- Fresh deployment defaults both toggles off and performs zero AI/vector calls.
- Enabling semantic search creates durable embedding jobs; disabling it stops claims and BM25 continues to work.
- Enabling automatic tags applies normalized AI assignments automatically, preserves manual assignments, and honors suppressions after manual deletion.
- Re-running a job for the same item/content hash is idempotent.
- Lease expiry, retries, malformed model JSON, 403/429, and out-of-capacity responses are covered.
- Vectorize and AI failures produce a visible degraded/unavailable state without breaking ingest or search.

### Release checks

- Focused database, API, settings, enrichment, extension, and UI tests pass.
- Extension compile and production build pass.
- Web typecheck and production build pass.
- `git diff --check` passes for the implementation patch.
- Local browser acceptance covers source removal, settings toggles, progress/status, hybrid-search fallback, and automatic-tag behavior with fake providers.
- A first clean-account Cloudflare deploy remains a separate external acceptance gate; local tests and a successful build do not prove deployment, account permissions, quota behavior, or authenticated provider capture.

## 7. Alternatives considered

### Provision resources only after opt-in

This minimizes empty resources but requires a second deployment or manual Cloudflare setup, which conflicts with the self-hosted near-zero-configuration goal.

### D1-only vector search

This avoids Vectorize but requires loading and comparing many vectors in Worker code, making latency, CPU, and memory scale poorly under Workers Free limits. It is not the chosen path.

