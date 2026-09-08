# Local Embedding Provider for Cloudflare-First Semantic Search

**Date:** 2026-09-07
**Status:** Design approved for written-spec review
**Scope:** Local semantic-search validation and a provider seam that does not add setup to the hosted user path

## Goal

Make Anansi's semantic-search behavior testable locally while keeping Cloudflare Workers AI + Vectorize as the hosted production path. Normal users must not download a model, install a model runtime, configure a local vector database, or provide another provider key. A future self-hosting mode may support local inference, but it is not part of the first user-facing path.

The first milestone is deliberately narrow:

1. define a provider boundary shared by hosted and local inference without exposing local setup in the hosted UI;
2. run a small local model against a synthetic bookmark set and a local vector index;
3. exercise semantic candidate retrieval end-to-end so semantic-only matches can appear;
4. preserve BM25 fallback and D1-owned authorization/filtering.

## Current context

The hosted implementation uses `@cf/baai/bge-small-en-v1.5` with 384 dimensions and Cloudflare Vectorize. The current `/api/search` route queries D1 BM25 first and then only reorders those rows using Vectorize results. Vectorize-only candidates are therefore discarded. MCP and CLI search call the database BM25 path directly and are not semantic-search acceptance paths.

Local development has no Vectorize emulator. Existing tests cover embedding-response parsing and reciprocal-rank-fusion arithmetic, but not the full search route, provider/index interaction, semantic-only retrieval, or a real model.

## Architecture

### Embedding provider

Introduce a small `EmbeddingProvider` interface with these responsibilities:

- embed one or more bounded text inputs;
- report the model identifier and vector dimension;
- reject malformed, non-finite, or dimension-mismatched vectors;
- expose provider failures as typed, observable errors.

Adapters:

- **Cloudflare provider:** wraps the existing Workers AI binding and remains the default for deployed Workers.
- **Local provider:** runs `Xenova/bge-small-en-v1.5` through Transformers.js 4.2 outside the browser and outside the repository. It emits the same 384-dimensional contract and is invoked only by the explicit `bun run semantic:local` developer command.

The local provider is an internal development/test capability for the first milestone. It must not appear as a required setup step, silently replace a configured Cloudflare provider, or add a second configuration path to the hosted UI. A future self-hosting mode must be designed and documented separately.

### User-facing hosted flow

The hosted installation provisions the AI and Vectorize bindings as part of the existing Cloudflare deployment. After deployment, the user only enables Semantic Search from Settings and can monitor indexing progress. No model download, local runtime, Vectorize index creation, or AI provider key is exposed as a user task.

### Vector index boundary

The search path must treat the vector index as a candidate/ranking service, not an authorization store. D1 remains authoritative for item existence, ownership, visibility, source/tag/favourite filters, and returned item fields.

Define a `VectorIndex` interface separate from `EmbeddingProvider`, with upsert, query, and delete operations. The hosted adapter wraps Cloudflare Vectorize. The local adapter uses an in-memory brute-force index for the small diagnostic corpus; it does not need Cloudflare credentials or a remote service. A full local persistent vector database is explicitly out of scope for this milestone, but the interface should leave room for a future local SQLite/vector-index adapter.

The local end-to-end test must run the same search orchestration with the local embedding provider and local vector index. It must not substitute a fake vector result for the core candidate-union, D1 hydration, filtering, and ranking behavior.

### Search flow

For semantic-enabled search:

1. run the existing filtered BM25 query;
2. embed the query through the selected provider;
3. retrieve a bounded vector-candidate set;
4. union and deduplicate lexical and vector IDs;
5. fetch vector-only IDs from D1 and reapply all authorization and exact filters;
6. fuse lexical and semantic ranks deterministically;
7. return D1-backed rows and an explicit degraded status if semantic work failed.

When semantic search is disabled, unavailable, over quota, or failed, the route must continue returning BM25 results. Provider failures must be observable in diagnostics/logging; they must not be silently indistinguishable from a successful semantic search.

## Local model lifecycle

- Provide an explicit setup/download command or script, rather than downloading on application startup.
- Store model files in a user/cache directory ignored by Git.
- Document approximate disk/download requirements and a cleanup command.
- Keep the local model developer-only for this milestone; a clean checkout and the hosted user path must work without it.
- Do not send captured bookmark text to a third-party local-model service by default.

## Testing strategy

### Contract tests

Run the same provider contract against a fake provider, the local provider, and the Cloudflare adapter seam where feasible:

- output is finite and exactly 384-dimensional;
- empty and overlong input is bounded consistently;
- malformed provider output fails with a typed error;
- model/dimension mismatches are rejected.

### Search integration test

Use a synthetic corpus containing labeled semantic pairs. At least one query must use different wording from the relevant item so BM25 returns no relevant row while the local vector index does. The test must prove that the vector-only item is returned after candidate union and D1 hydration. This test runs entirely locally after the model is downloaded; it does not call Cloudflare.

Also verify:

- source, tag, favourite, archived, and removed filters remain correct;
- inaccessible or deleted D1 rows never leak through vector metadata;
- changed content receives a new embedding;
- deleted content is removed or ignored by the vector index;
- disabled or failed semantic search falls back to BM25 without a 500 response;
- deterministic ordering and cursor behavior remain defined.

### Local smoke test

The local smoke test downloads the model only after explicit user action, indexes a small synthetic library in the local vector index, runs the real local search orchestration, and reports:

- model identifier and dimension;
- indexed item count;
- top-k results for each query;
- whether each expected semantic match was retrieved;
- BM25-only versus semantic result differences;
- failures and elapsed time.

This is the primary evidence that semantic retrieval logic works. A separate hosted smoke test remains required only for Workers AI, Vectorize, D1, authentication, and quota behavior.

### Alchemy development smoke test

Run the Worker locally with `alchemy dev` against a dedicated remote AI binding and development Vectorize index. This validates the real Cloudflare model and index APIs without requiring a code push for each edit. It is an engineering workflow, not a user setup requirement. Remote writes, credentials, network access, and Cloudflare quota usage must be explicit in the test instructions.

## Acceptance criteria

The milestone is complete when:

1. local setup is opt-in and does not alter default hosted configuration;
2. the local provider produces the agreed 384-dimensional contract;
3. the local vector index supports the required upsert/query/delete behavior;
4. a fully local semantic-only integration test retrieves a vector candidate that BM25 misses;
5. the search orchestration hydrates and filters vector-only candidates from D1;
6. BM25 fallback remains functional when local or hosted AI is unavailable;
7. local model files and synthetic data are excluded from commits;
8. an Alchemy development smoke test exercises real Workers AI and Vectorize through remote bindings;
9. the default hosted user flow requires no local model, local vector index, or additional AI key;
10. the hosted Cloudflare path remains the documented production target;
11. no claim is made that MCP/CLI semantic search works until those paths are explicitly wired and tested.

## Non-goals

- replacing Workers AI + Vectorize for hosted Anansi;
- downloading model weights in the browser;
- bundling model weights in the repository;
- implementing a full local persistent vector database in this milestone;
- adding conversational Agents behavior;
- changing AI tagging;
- making local model setup part of the default user-facing installation;
- claiming production or clean-account acceptance from local model results.
