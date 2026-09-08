# Ollama local semantic search implementation plan

**Date:** 2026-09-07
**Design:** `docs/superpowers/specs/2026-09-07-ollama-local-semantic-search-design.md`
**Goal:** Add an explicit Ollama-backed local web search path with a persistent SQLite vector sidecar while preserving the hosted Cloudflare path and immediate BM25 fallback.

## Execution rules

- Preserve unrelated work. At plan approval, the only unrelated working-tree content is the untracked `outputs/` directory; do not add, delete, or rewrite it.
- Use `apply_patch` for source and documentation edits. Keep model files, local vectors, sidecar databases, and synthetic data outside tracked paths or under ignored paths.
- Do not modify the hosted Cloudflare AI/Vectorize setup except where shared provider types need to remain compatible.
- Do not expose Ollama configuration in hosted settings or require it for install, build, tests, `bun run dev:local`, or deployment.
- Reuse `packages/db`'s canonical `ai_enrichment_jobs` queue and `item_embeddings` metadata. Do not create a second durable queue in the sidecar.
- Keep D1/SQLite authoritative for item existence, ownership, visibility, exact filters, and returned fields. Never trust sidecar IDs or vector metadata as authorization.
- Keep MCP and CLI search keyword-only in this slice.
- Do not claim hosted or authenticated acceptance from local Ollama evidence. Run any remote Alchemy smoke only with explicit developer credentials, an isolated stage/index, synthetic data, and opt-in commands.
- Run focused tests and `git diff --check`; do not run repository-wide formatting commands that rewrite unrelated files.

## Current seams and constraints

- `apps/web/src/server/ai.ts` already exposes injectable `EmbeddingProvider`, `VectorIndex`, Cloudflare AI/Vectorize adapters, vector validation, and rank fusion.
- `apps/web/src/server/semantic-search.ts` already performs first-page hybrid orchestration, semantic-only candidate hydration, filter preservation, and safe degraded reasons.
- `apps/web/src/server/api.ts` injects Cloudflare adapters when `ai` and `vectorize` bindings are present; local `serve-local.ts` currently supplies neither.
- `apps/web/src/server/env.ts` resolves Worker bindings or local SQLite but has no Ollama configuration.
- `packages/db/src/ai-jobs.ts` owns `reconcileAiJobs`, lease/retry claim/complete/fail, `searchableText`, content hashing, `item_embeddings`, and AI progress.
- `apps/web/scripts/serve-local.ts` owns the Bun SQLite HTTP process and is the correct local-only place to open `bun:sqlite`, start the semantic worker, and pass local provider/cache seams to `handleApi`.
- `apps/web/vite.config.ts` already excludes `bun:sqlite` and `cloudflare:workers`; keep Ollama/local-cache modules out of the browser bundle.

## Phase 0: baseline and dependency boundary

### Task 0.1: Record status and focused baseline

Inspect:

- `git status --short`
- the approved design and this plan;
- `apps/web/src/server/ai.ts`, `semantic-search.ts`, `api.ts`, `env.ts`, `worker.ts`;
- `apps/web/scripts/serve-local.ts`, `apps/web/vite.config.ts`, `scripts/dev.ts`;
- `packages/db/src/ai-jobs.ts`, `queries.ts`, `search.ts`, `schema.ts`, local migrations;
- `apps/web/src/lib/api.ts`, library query/UI components, `README.md`, `.env.example`, `.gitignore`.

Run the current focused suite and record unrelated failures separately:

```powershell
bun test apps/web/src/server/ai.test.ts apps/web/src/server/api.test.ts packages/db/src/search.test.ts
bun run typecheck
bun run --cwd apps/web build
git diff --check
```

### Task 0.2: Keep runtime packages server-only

Confirm the Ollama HTTP adapter and Bun SQLite sidecar are imported only by the local/server graph. If a module is reachable by the browser bundle, split it or use a server-only dynamic import. Do not add an Ollama client package when `fetch` is sufficient.

Suggested commit: `chore(search): prepare local Ollama runtime boundary`

## Phase 1: provider and local configuration

### Task 1.1: Add the Ollama embedding adapter

Create a focused server module such as `apps/web/src/server/ollama-embedding.ts` and extend `apps/web/src/server/ai.ts` only for shared error/contract types.

The adapter must:

- default to `http://127.0.0.1:11434` and accept a developer-only override;
- call `POST /api/embed` with `model` and bounded `input` text/arrays;
- use `AbortController` timeouts and a bounded batch size;
- parse the documented `{ model, embeddings }` response shape;
- validate finite numbers and one observed dimension per model identity;
- classify connection refusal, missing model, timeout, temporary HTTP error, malformed response, and dimension mismatch without retaining raw bodies;
- expose provider model identity/dimension and a lightweight health/model availability check for status reporting.

Add unit tests with a fake fetcher for request shape, batch bounds, successful parsing, missing model, timeout, malformed/non-finite values, and wrong dimensions. Tests must not contact Ollama.

### Task 1.2: Resolve local provider settings

Update `apps/web/src/server/env.ts` and the local launcher so local mode can receive:

- `OLLAMA_BASE_URL` (loopback default);
- `OLLAMA_EMBEDDING_MODEL` (`embeddinggemma` default);
- an explicit local semantic enablement flag if needed, defaulting off until the developer opts in.

Hosted Worker resolution must ignore these variables and continue selecting Cloudflare bindings. Add safe config/status types that never serialize credentials or raw URLs to the browser unless the local status contract explicitly permits a redacted loopback label.

### Task 1.3: Add documented model setup

Update `.env.example` and the local section of `README.md` with the explicit Ollama prerequisites and commands:

```bash
ollama pull embeddinggemma
```

Document the default model and the `nomic-embed-text`/`nomic-embed-text-v2-moe` alternatives, approximate sizes, model-change rebuild behavior, cache location, and cleanup/rebuild commands. Make clear that this is developer-only and not part of hosted setup.

Suggested commit: `feat(search): add local Ollama embedding provider`

## Phase 2: persistent SQLite sidecar

### Task 2.1: Implement the sidecar store

Create a local-only module such as `apps/web/src/server/local-semantic-cache.ts` backed by `bun:sqlite`. Keep the import behind the Bun local-server boundary and exclude it from Vite/browser bundling.

Store the sidecar below `${ANANSI_DATA_DIR}/semantic/ollama.sqlite` (or the resolved local data directory) with migrations created by the module itself. Define tables for:

- active index metadata/generation, provider/model fingerprint, dimension, status, timestamps, and safe diagnostic code;
- item ID, projection hash, generation, dimension, normalized float32 vector bytes, and timestamps.

Reuse canonical `ai_enrichment_jobs` for queue state and canonical `item_embeddings` for per-item model/hash/status metadata. The sidecar must support lookup by item/hash/generation, upsert, invalidation, bounded iteration for brute-force query, active-generation swap, and old-generation cleanup.

Use a stable serialization for float32 vectors and deterministic score/ID ordering. Reject reads whose bytes, dimensions, or generation identity are invalid. Do not persist raw bookmark payloads or provider responses.

### Task 2.2: Add sidecar lifecycle tests

Test fresh creation, reopen/persistence, upsert replacement, duplicate idempotency, delete/invalidation, dimension mismatch, generation isolation, atomic activation, old-generation cleanup, and deterministic cosine top-k/tie ordering. Use a temporary test file and remove it in test teardown.

Suggested commit: `feat(search): add persistent local semantic sidecar`

## Phase 3: embedding text and local indexing worker

### Task 3.1: Define the versioned semantic projection

Add a focused function near `packages/db/src/ai-jobs.ts` (or a new shared module) for bounded semantic text. It should combine title, meaningful body/article excerpt, author fields, tags, source, and canonical URL in a stable order, exclude raw JSON/unstable metrics, and apply a fixed model-safe cap. Include the projection version in its hash so a future text-format change requeues items.

Keep existing `searchableText` behavior stable for current hosted AI/tagging callers unless a shared change is proven safe and tested.

Add fixtures asserting deterministic output, bounded length, and hash changes when meaningful content changes.

### Task 3.2: Reuse and extend the canonical embedding queue

Update the reconciliation path so local semantic enablement creates `embedding` jobs in `ai_enrichment_jobs` with the projection hash. Do not create a `semantic_queue` table. Ensure edits, duplicate events, and deleted items converge to one current job/metadata state.

### Task 3.3: Implement the local worker

Create a server-only worker module such as `apps/web/src/server/local-semantic-worker.ts` that:

- claims only `embedding` jobs using existing leases/retries;
- reads the canonical item and projection from SQLite;
- calls the Ollama provider in bounded batches;
- writes valid vectors to the sidecar and updates `item_embeddings` metadata;
- completes successful jobs and records safe failure codes through existing retry helpers;
- invalidates vectors for missing/deleted items;
- reports ready/warming/unavailable/paused status without logging bodies or tokens.

Wire `apps/web/scripts/serve-local.ts` to open the sidecar, reconcile jobs, process a bounded batch on startup, and poll at a conservative interval. The worker must not run AI tagging locally just because `autoTaggingEnabled` is set. A save request must not wait for this worker.

Add lifecycle tests for new item, edit, delete, duplicate, Ollama unavailable, retry/backoff, and model-generation rebuild. Use fake providers and a temporary sidecar.

Suggested commit: `feat(search): index local items through Ollama sidecar`

## Phase 4: connect local search and status UI

### Task 4.1: Inject the local provider/index into the API

Extend `ApiEnv` with a local semantic adapter/status seam without changing hosted binding behavior. In local `serve-local.ts`, pass the Ollama provider and sidecar-backed `VectorIndex` to `handleApi`; in Worker mode continue passing Cloudflare AI/Vectorize adapters.

Update the coordinator so:

- local semantic queries use vectors from the active sidecar generation;
- semantic-only IDs are hydrated through `hydrateSearchItems` and all existing filters;
- BM25 remains the immediate fallback;
- first-page/cursor behavior remains explicit and safe;
- status distinguishes unavailable provider, warming sidecar, paused/error generation, and successful semantic application.

Add API tests for local provider success, semantic-only result, hidden/deleted/filter-mismatched vector IDs, cursor boundary, disabled semantic mode, Ollama outage, and invalid vector response.

### Task 4.2: Render explicit local status

Update `apps/web/src/lib/api.ts`, the library search UI, and settings/status UI only where needed. Render non-blocking local notices for ready, warming, unavailable, and paused/error states. Include pending/vector counts where useful and a rebuild action that is local-only. Do not expose local-only copy when Cloudflare is the active provider.

Add component tests for all notices, BM25 result preservation, no raw error display, and no Ollama setup controls for hosted mode.

Suggested commit: `feat(search): expose local semantic status and fallback`

## Phase 5: explicit Ollama smoke test

### Task 5.1: Add the real local command

Replace or extend the existing Transformers.js-only smoke path with a clearly named developer command, for example:

```bash
bun run semantic:ollama
```

The command must require explicit invocation, verify the configured Ollama daemon/model, construct a neutral synthetic corpus, write vectors through the real sidecar, and execute the real hybrid search orchestration. It must report model identity, observed dimension, corpus/index/pending counts, query result IDs, BM25-versus-semantic differences, status, and elapsed time. Exit non-zero if the required semantic-only match is missed.

Keep the existing Transformers.js provider only if it still provides useful offline contract coverage; do not make two local UI paths. The smoke command must not use private captures, Cloudflare credentials, or a public Ollama URL by default.

### Task 5.2: Add ignored-state guardrails

Update `.gitignore` for the sidecar and any local Ollama smoke output. Verify a clean `git status --short` after the smoke command except for the pre-existing `outputs/` directory. Document model/cache cleanup without deleting user data automatically.

Suggested commit: `test(search): add Ollama semantic smoke command`

## Phase 6: hosted regression and documentation boundary

### Task 6.1: Verify hosted adapter compatibility

Run the existing focused hosted adapter and search tests. Confirm `packages/infra/alchemy.run.ts` still provisions Workers AI and Vectorize with the configured hosted model/dimension. Do not route hosted traffic to Ollama.

If credentials are explicitly available, run the separate Alchemy development smoke against an isolated remote stage/index with synthetic data. Record remote-binding, quota, and network evidence separately from the local smoke result. Do not make this remote check part of default tests.

### Task 6.2: Update user-facing documentation

Ensure the README says:

- hosted users only enable Semantic Search after deployment;
- no Ollama, local model, vector database, or additional AI key is required for hosted use;
- local Ollama setup is developer-only;
- local semantic results are not evidence of MCP/CLI or deployed-provider acceptance.

Keep existing Cloudflare setup and its current verification boundary intact.

Suggested commit: `docs(search): document Ollama local workflow`

## Phase 7: integrated validation

Run:

```powershell
bun test apps/web/src/server/ai.test.ts apps/web/src/server/api.test.ts packages/db/src/search.test.ts
bun test apps/web/src/server/ollama-embedding.test.ts apps/web/src/server/local-semantic-cache.test.ts apps/web/src/server/local-semantic-worker.test.ts
bun run semantic:ollama
bun run typecheck
bun run --cwd apps/web build
git diff --check
```

Run the Alchemy remote smoke only with explicit stage/credential opt-in. Record separately:

- local Ollama/provider/sidecar evidence;
- local API/UI/fallback evidence;
- hosted adapter/Alchemy evidence;
- deployed preview and authenticated evidence, if later obtained;
- remaining MCP/CLI semantic-search gaps.

## Completion criteria

- The local web UI uses real Ollama embeddings when explicitly enabled.
- New bookmarks save immediately, appear in BM25, and are asynchronously indexed through the existing durable embedding queue.
- Vectors persist in the ignored SQLite sidecar and are isolated by model, generation, projection hash, and dimension.
- Semantic-only candidates are unioned, hydrated, filtered, and returned as canonical database rows.
- Ollama-unavailable, warming, paused, and error states are visible without blocking BM25.
- Model changes rebuild safely without mixed vector spaces.
- Default install, test, build, local start, and hosted deployment require no Ollama or model files.
- Hosted Cloudflare AI/Vectorize behavior remains unchanged and is verified separately.
- No production, authenticated, MCP, or CLI semantic-search claim is made without its own evidence.
