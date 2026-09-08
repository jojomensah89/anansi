# Local semantic search and Cloudflare development verification plan

**Date:** 2026-09-07
**Design:** `docs/superpowers/specs/2026-09-07-local-embedding-provider-design.md`
**Goal:** Prove and repair semantic retrieval locally, then verify the same code against real Workers AI and Vectorize through `alchemy dev`, without adding any model setup to the hosted user path.

## Execution rules

- Preserve all pre-existing work. At plan creation the only unrelated working-tree content is the untracked `outputs/` directory; do not add, delete, or rewrite it.
- Keep local model files, caches, generated vectors, and synthetic output outside tracked paths or under ignored paths.
- Do not change the default hosted setup: `packages/infra/alchemy.run.ts` continues to provision Workers AI and Vectorize, and users enable Semantic Search from Settings.
- Do not expose a local-model toggle, local runtime requirement, model download, vector database setup, or additional provider key to hosted users in this milestone.
- Keep D1 authoritative for visibility, authorization, exact filters, and returned item data. Never trust Vectorize metadata for access control.
- Do not change AI tagging, source parsers, MCP semantics, or the extension in this slice.
- Do not call remote Cloudflare bindings from offline tests. Remote Alchemy checks must use a clearly isolated development stage/index and synthetic data; never use production data.
- Do not claim clean-account deployment or authenticated provider acceptance from the local model or `alchemy dev` tests.
- Use focused checks and `git diff --check`; do not run repository-wide formatting commands that rewrite unrelated files.

## Phase 0: Baseline and runtime selection

### Task 0.1: Record current state and focused baseline

Inspect:

- `git status --short`
- `apps/web/src/server/api.ts`
- `apps/web/src/server/ai.ts`
- `apps/web/src/server/env.ts`
- `apps/web/src/server/api.test.ts`
- `packages/db/src/search.ts`
- `packages/db/src/schema.ts`
- `packages/infra/alchemy.run.ts`
- `packages/infra/package.json`
- `README.md`

Run:

```powershell
bun test apps/web/src/server/ai.test.ts apps/web/src/server/api.test.ts packages/db/src/search.test.ts
bun run typecheck
bun run --cwd apps/web build
git diff --check
```

Record unrelated failures separately. Do not start `alchemy dev` during baseline; it may create or connect to remote resources.

### Task 0.2: Select the local inference runtime

Use a Transformers.js-compatible BGE-small checkpoint that emits 384-dimensional vectors and runs under the repository's Node/Bun environment. Model weights are downloaded only by an explicit developer command and cached outside Git. Confirm the runtime with a one-text smoke test before wiring it into search.

Exit condition: the chosen runtime can load the model, embed one string, return finite 384-dimensional values, and run on the supported Windows developer environment without changing the production bundle.

## Phase 1: Separate provider and index seams

### Task 1.1: Define injectable provider contracts

Modify:

- `apps/web/src/server/ai.ts`
- `apps/web/src/server/env.ts`

Add small contracts for:

- `EmbeddingProvider.embed(text)` plus model/dimension metadata;
- `VectorIndex.upsert`, `query`, and optional `deleteByIds`.

Keep the existing Workers AI and Vectorize adapters compatible with their current bindings. Validate finite vectors and configured dimensions at the seam. Preserve typed error classification and add an explicit degraded-search reason that can be surfaced without leaking provider details.

Add unit tests for malformed vectors, dimension mismatches, provider failures, and deterministic local index behavior.

Suggested commit: `refactor(search): add embedding and vector index seams`

### Task 1.2: Add a local brute-force vector index

Create a small developer/test module under `apps/web/src/server/` or `scripts/` that:

- stores `id -> vector` in memory;
- supports upsert, cosine-similarity query, and delete;
- returns bounded `{ id, score }` matches in deterministic order;
- does not persist model weights or vectors in the application database.

Test empty indexes, duplicate IDs, replacement vectors, deletion, dimension mismatch, ties, and top-k limits.

Suggested commit: `test(search): add local vector index`

## Phase 2: Repair semantic candidate retrieval

### Task 2.1: Extract filtered D1 hydration

Modify `packages/db/src/search.ts` to add a D1/SQLite query helper that hydrates a bounded set of item IDs into `SearchHit` rows while reapplying:

- hidden-source visibility;
- source, author, tag, media, content type, archived, removed, favourite, and date filters;
- deterministic ID ordering for ties.

Reuse existing projection and decoration logic where possible. Do not duplicate authorization rules in the vector index.

Add tests proving inaccessible, hidden, deleted, and filter-mismatched IDs are excluded.

### Task 2.2: Extract hybrid search orchestration

Create a focused module such as `apps/web/src/server/semantic-search.ts` that:

1. receives the filtered BM25 page and search options;
2. embeds the query through the selected provider;
3. queries the vector index for a bounded candidate set;
4. unions and deduplicates lexical and vector IDs;
5. hydrates vector-only IDs through the D1 helper;
6. fuses lexical and semantic ranks deterministically;
7. preserves the existing response shape and cursor contract, or explicitly documents a safe first-page limitation if relevance paging cannot remain keyset-compatible.

Modify `apps/web/src/server/api.ts` to call this orchestration. Keep BM25 fallback on disabled, absent, failed, or quota-paused semantic search. Replace the current silent catch with a non-sensitive degraded status/diagnostic path.

Add route-level tests using injected local provider/index seams:

- a semantic-only result appears when BM25 returns no relevant row;
- lexical and semantic results are deduplicated;
- all filters and hidden-source rules remain authoritative;
- disabled/failing semantic search returns BM25 results and no 500;
- deterministic ordering is stable.

Suggested commit: `fix(search): include semantic-only candidates`

## Phase 3: Real local model smoke test

### Task 3.1: Add explicit developer command

Add a developer-only script, for example `scripts/semantic-local-smoke.ts`, and a root script such as:

```powershell
bun run semantic:local
```

The command must:

- download/cache the selected BGE-small model only after explicit invocation;
- build a small synthetic corpus with labeled semantic pairs;
- compute item vectors with the local provider;
- query the same local search orchestration and local vector index;
- compare BM25-only and semantic results;
- print model ID, dimensions, corpus size, query results, expected-match status, duration, and failures;
- exit non-zero if a required semantic-only match is missed.

Keep the command out of the production web bundle and do not require it for `bun install`, `bun run dev:local`, or hosted deployment.

### Task 3.2: Add local semantic fixtures

Use neutral synthetic text, for example a bookmark about nearest-neighbour indexing queried with “finding similar documents,” plus several distractors and filter cases. Do not use private captures or provider payloads. Ensure at least one BM25 miss/vector hit is a required assertion.

Suggested commit: `test(search): add local semantic smoke test`

## Phase 4: Alchemy development verification

### Task 4.1: Confirm remote-binding behavior against current Alchemy

Use the existing `packages/infra/alchemy.run.ts` bindings and current `alchemy` version. Verify from the Alchemy/Cloudflare plan that `alchemy dev` runs Worker code locally while AI and Vectorize are remote-backed. Do not add a local emulator claim.

Create a short developer-only runbook or script that:

- selects an isolated development stage/index;
- starts `packages/infra` with `alchemy dev`;
- seeds only synthetic items;
- enables semantic search for that stage;
- runs the same semantic-only query set;
- records remote binding availability, embedding/vector counts, result IDs, failures, and quota/network errors without printing credentials.

The check must be opt-in and must not run as part of normal tests or CI unless remote credentials and an explicit opt-in variable are present.

### Task 4.2: Verify hosted adapter contracts

With local Worker code and remote AI/Vectorize:

- confirm the configured model returns 384 dimensions;
- confirm item upserts and query results use stable item IDs;
- confirm changed content receives a replacement vector;
- confirm deleted items do not remain searchable after the supported deletion path;
- confirm the repaired candidate-union path returns a Vectorize-only item;
- confirm the degraded path remains safe when a remote call fails.

Suggested commit: `docs(search): document Alchemy semantic smoke test`

## Phase 5: User-path and documentation guardrails

### Task 5.1: Keep hosted setup zero-config for semantic search

Review `README.md`, Settings UI copy, and deployment docs. Ensure they say:

- AI and Vectorize are provisioned by the existing Cloudflare deployment;
- users only enable Semantic Search and monitor progress;
- no local model, Python runtime, local vector database, or extra AI key is required;
- local model commands are developer-only and not part of the installation path.

Do not claim semantic search is complete until the local and Alchemy checks pass.

### Task 5.2: Preserve other search paths honestly

Keep CLI/MCP documentation keyword-only until those paths are deliberately wired to the hybrid orchestrator and tested. Do not imply that web UI semantic verification proves MCP semantic search.

## Phase 6: Integrated validation

Run:

```powershell
bun test apps/web/src/server/ai.test.ts apps/web/src/server/api.test.ts packages/db/src/search.test.ts
bun run semantic:local
bun run typecheck
bun run --cwd apps/web build
git diff --check
```

Run the Alchemy remote smoke only with explicit credentials/stage opt-in. Record separately:

- offline local-model evidence;
- Alchemy local-code/remote-service evidence;
- deployed preview evidence;
- any remaining MCP/CLI or authenticated-provider gaps.

## Completion criteria

- The hosted user path has no additional semantic-search setup beyond enabling the existing setting.
- A real local model and local vector index prove semantic-only retrieval offline.
- The web route includes vector-only candidates after D1 hydration and filtering.
- BM25 fallback and degraded diagnostics work.
- Alchemy development verifies real Workers AI and Vectorize without requiring a code push for each edit.
- Model weights, local vectors, synthetic data, credentials, and remote dev state are not committed.
- Production or clean-account readiness is not claimed until the separate deployment gate passes.
