# Cloudflare AI Enrichment and TikTok Retirement Implementation Plan

> Based on the approved design in `docs/superpowers/specs/2026-09-06-cloudflare-ai-enrichment-tiktok-retirement-design.md`.

## Execution order

1. Establish shared visibility/config contracts and retire TikTok from shipped runtime and web surfaces.
2. Add D1 AI settings, enrichment state, provenance, and lease/retry helpers.
3. Add Workers AI/Vectorize adapters, reconciliation, embedding/tagging jobs, and hybrid-search fallback.
4. Add settings/API/UI controls and Cloudflare bindings/index provisioning.
5. Run focused tests, full checks, local browser acceptance, and document remaining deployment/authenticated gates.

## Work packets

### 1. TikTok runtime retirement

- Remove TikTok from WXT-built entrypoints, host permissions, relay matches, background source scheduling, popup source rows, and popup config validation.
- Preserve the TikTok parser/platform modules and sanitized fixtures for future repair outside the shipped entrypoint graph.
- Remove TikTok from the web source catalogue, filters, rail, creators, labels, and source responses.
- Add a shared hidden-source predicate at the database/API boundary and apply it to list, search, stats, creators, recent, detail, tags, and MCP paths. Retain rows; do not delete data.
- Update source/API/extension tests and README source status.

Acceptance: extension compile/build has no TikTok content script or host permission; user-visible source lists contain X, Reddit, GitHub, and Web; direct TikTok query/detail paths are empty/404; old rows remain in D1; parser tests remain green.

### 2. D1 schema and durable enrichment jobs

- Add migrations and Drizzle schema for `ai_settings`, `ai_enrichment_jobs`, `item_embeddings`, and `item_tag_overrides`.
- Extend `item_tags` with assignment provenance/model/timestamp while preserving its existing key.
- Implement canonical searchable-text hashing and idempotent reconciliation for enabled features.
- Implement lease claim, completion, failure/backoff, and pause-state helpers modelled on media jobs.

Acceptance: schema migrations work in SQLite and D1 shapes; duplicate reconciliation is harmless; expired claims can be reclaimed; failures back off and are bounded.

### 3. AI providers and hybrid search

- Define small runtime interfaces for Workers AI embedding/tag calls and Vectorize query/upsert/delete so tests can inject fakes.
- Implement Workers AI calls with bounded input, strict tag JSON parsing, label normalization, and error classification.
- Implement Vectorize upsert/query using stable item IDs and the configured 384-dimensional model.
- Add Worker Cron processing with a small batch/concurrency cap and no paid Queues/Durable Objects.
- Extend search with optional hybrid BM25 + Vectorize reciprocal-rank fusion and deterministic cursors; retain BM25 fallback for disabled/unavailable/quota states.

Acceptance: new/changed items enqueue, vectors/tag assignments are idempotent, malformed output is rejected, manual suppression is honored, AI failures never break ingest/BM25/MCP, and hybrid search falls back cleanly.

### 4. Settings/API/UI and deployment

- Add authenticated AI settings/status endpoints and UI with independent Semantic Search and Automatic Tags toggles, progress, errors, and quota messaging.
- Add `AI` and `VECTORIZE` bindings plus a Vectorize V2 index resource to Alchemy; keep features off by default.
- Extend Worker bindings and Cron handler without breaking local runtime when bindings are absent.
- Add deployment/config documentation and update README roadmap/source status.

Acceptance: fresh install performs no AI/vector calls; toggles persist; disabling stops new claims without deleting artifacts; absent bindings show unavailable while the library remains usable; deployment plan contains no manual index/key step.

### 5. Verification

- Focused DB/API/AI/extension/UI tests.
- Extension compile and production build.
- Web typecheck and production build.
- Full `bun test`, `git diff --check`, and React Doctor for changed React files.
- Local browser checks for TikTok absence, AI settings, disabled fallback, and fake-provider progress/error states.
- Clearly separate local evidence from clean-account Cloudflare deployment and authenticated provider acceptance.

