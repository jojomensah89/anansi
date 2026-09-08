# Ollama Local Semantic Search Design

**Date:** 2026-09-07
**Status:** Approved and implemented; live Ollama smoke remains an explicit developer check
**Scope:** Local web UI semantic search using Ollama, with a persistent sidecar vector cache and safe BM25 fallback

## Decision summary

Anansi will use Ollama as the developer-controlled local embedding service for the local web UI. The local server will call Ollama's loopback HTTP API; the browser will not call Ollama directly. Embeddings will be persisted in a SQLite sidecar cache under the configured local data directory. D1/SQLite remains authoritative for item data, authorization, visibility, and filters.

The local semantic path is optional and does not change the hosted user setup. Hosted Cloudflare deployments continue to use the existing Workers AI and Vectorize adapters. Hosted users do not install Ollama, download model weights, configure a local vector database, or provide another provider key.

This document supersedes the local-runtime and local-index choices in `2026-09-07-local-embedding-provider-design.md`: the local web UI path is Ollama plus a persistent sidecar, while the existing Transformers.js path remains useful only as an offline contract/test provider where retained. The Cloudflare-first hosted decision is unchanged.

## Goals

1. Use a real local embedding model in the local web UI so semantic search can be exercised without Cloudflare credentials or network access to a hosted AI provider.
2. Keep bookmark capture and keyword search functional when Ollama is missing, stopped, warming, or failing.
3. Avoid repeated embedding work by caching vectors across local server restarts.
4. Make model changes safe by never mixing vectors from different model identities or dimensions.
5. Preserve D1/SQLite as the authority for access control, item existence, source visibility, exact filters, and returned fields.
6. Keep local setup explicit and developer-controlled rather than adding it to the hosted user journey.

## Non-goals

- Replacing Workers AI or Vectorize for hosted Anansi.
- Downloading model weights in the browser or bundling weights in the repository.
- Adding a model picker or Ollama settings screen for end users.
- Exposing the Ollama API or local vector cache to the public internet.
- Implementing a separate Qdrant, LanceDB, or other vector-database service for the first version.
- Making bookmark ingestion wait synchronously for a local model.
- Changing AI tagging, source parsers, extension transport, MCP behavior, or CLI search semantics in this slice.
- Claiming hosted, authenticated, or MCP semantic-search readiness from the local Ollama smoke test.

## Architecture

### Local request boundary

The browser continues to call Anansi's existing local API. Only the server-side provider adapter talks to Ollama:

```text
Browser -> Anansi /api/search -> Ollama http://127.0.0.1:11434/api/embed
                           \-> local SQLite semantic sidecar
```

The default Ollama base URL is loopback. A non-loopback URL is an explicit developer override, disabled in hosted mode and accompanied by a warning because bookmark text would leave the local machine. The browser never receives an Ollama URL, model credential, or raw provider error.

### Components and seams

#### `OllamaEmbeddingProvider`

An adapter implementing the existing embedding-provider contract. It is responsible for:

- calling `POST /api/embed` with one string or a bounded array of strings;
- applying an abort timeout and bounded batch size;
- validating that every returned number is finite;
- discovering and enforcing one vector dimension per model identity;
- classifying unreachable daemon, missing model, timeout, malformed response, and temporary server errors;
- returning model identity and dimension metadata to the index coordinator.

The adapter is selected only in local mode when the developer explicitly enables the Ollama provider. The deployed Worker continues to select the Cloudflare Workers AI adapter.

#### `LocalSemanticCache`

A persistence adapter for a SQLite sidecar file. It stores vector bytes and index-generation state, not the canonical item record. It supports lookup by item ID/content hash, upsert, invalidation, status summaries, and generation rebuilds. Queue claim/complete/fail remains in Anansi's existing canonical `ai_enrichment_jobs` table so local and hosted enrichment use one durable job contract.

#### `VectorIndex`

The search seam remains separate from the embedding seam. The first local implementation performs brute-force cosine similarity over vectors loaded from the sidecar. It has deterministic score and item-ID tie-breaking and a bounded top-k result. This is adequate for a personal bookmark corpus and leaves room for a future approximate index without changing the provider contract.

#### `SemanticSearchCoordinator`

The coordinator combines BM25, provider, cache, and D1/SQLite hydration. It owns incremental indexing, provider status, semantic candidate retrieval, rank fusion, and degraded-result metadata. It must not treat vector metadata as authorization data.

## Model and developer configuration

The documented local defaults are:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=embeddinggemma
```

The setup is explicit:

1. Install or update Ollama (0.11.10 or newer for EmbeddingGemma).
2. Run `ollama pull embeddinggemma` once.
3. Start Anansi in local mode.

Anansi does not download a model on application startup. The README documents the approximate model size, the local data/cache location, and how to rebuild or remove the cache. The normal install, build, test, hosted deployment, and local web start paths do not require Ollama.

### Default and alternative models

The default is [`embeddinggemma`](https://ollama.com/library/embeddinggemma): Ollama documents it as a 300M-parameter retrieval embedding model, approximately 622 MB, trained across 100+ languages, with a 2K context window and an Ollama 0.11.10 minimum. Its vector dimension is accepted from the provider response and recorded in the cache; it is not assumed from the model name.

Documented alternatives are:

- [`nomic-embed-text`](https://ollama.com/library/nomic-embed-text): approximately 274 MB and a 2K context window; a lightweight fallback for English-heavy libraries.
- [`nomic-embed-text-v2-moe`](https://ollama.com/library/nomic-embed-text-v2-moe): approximately 958 MB, multilingual, 512-token context, and flexible 768-to-256 Matryoshka dimensions; an opt-in quality experiment, not the default.

All embedding requests use Ollama's documented [`/api/embed`](https://docs.ollama.com/api/embed) endpoint. Model-specific prefixes or input preparation belong inside the provider adapter and must be versioned with the model identity; callers pass semantic text, not model-specific prompt syntax.

## Sidecar storage

The sidecar file lives below the configured local data directory, for example:

```text
${ANANSI_DATA_DIR}/semantic/ollama.sqlite
```

The path is generated/ignored local state and is never committed. A minimal schema is:

### `semantic_index_meta`

- one active index-generation key;
- provider name;
- model name and digest/fingerprint when Ollama exposes one;
- vector dimension;
- status (`warming`, `ready`, `paused`, or `error`);
- created, updated, and last-success timestamps;
- last safe diagnostic code.

### `semantic_vectors`

- canonical `item_id`;
- content hash of the bounded embedding projection;
- index-generation key;
- vector dimension;
- normalized float32 vector bytes;
- created and updated timestamps.

### Queue reuse

The existing canonical `ai_enrichment_jobs` table is the queue for local embedding work. Its `embedding` jobs already carry the item ID, content hash, lease, retry, and failure state. The existing `item_embeddings` row remains the canonical per-item status/model/hash metadata used by progress and diagnostics; the sidecar holds the local vector bytes that cannot be stored in D1. No second queue is created.

The sidecar stores no raw provider payload. The bounded embedding projection is recomputed from the canonical item when a hash changes. Old generations remain isolated during a rebuild and can be garbage-collected after the new generation is ready.

## Embedded text and index lifecycle

The embedding text is deterministic and bounded. It contains the fields useful for retrieval—title, meaningful body or excerpt, tags, source, and canonical URL—in a stable order. It excludes raw provider JSON, unstable metrics, and unbounded media metadata. The projection applies a fixed character/token cap appropriate for the configured model and records its version in the content hash.

### New bookmark

1. The ingest transaction writes the canonical item and updates BM25/FTS.
2. After the item is committed, Anansi enqueues an `embedding` job in the existing `ai_enrichment_jobs` table with its ID and projection hash.
3. The local index worker claims queued jobs in bounded batches.
4. Ollama embeds the missing/changed projections.
5. Valid vectors are written to the sidecar and the jobs are marked complete.

The save operation does not wait for Ollama. A new bookmark is immediately available to keyword search and becomes available to semantic search once its vector is committed. Duplicate events with the same item and content hash are no-ops. Edits enqueue a replacement; deletes enqueue invalidation and remove the vector from active search.

### Startup and catch-up

On local startup, the coordinator reuses the existing reconciliation logic to compare canonical items with the active sidecar generation and queue missing or changed `embedding` jobs. A local worker claims those jobs with the existing lease/retry contract and processes them in the background. Search may use already-available vectors while the queue is catching up and reports `warming` until the active generation is complete.

## Hybrid search behavior

For a semantic-enabled query:

1. Run the existing filtered BM25 query.
2. Embed the query through the selected provider.
3. Query the sidecar for a bounded semantic candidate set.
4. Union and deduplicate lexical and semantic IDs.
5. Hydrate every candidate through D1/SQLite.
6. Reapply visibility, ownership, source, author, tag, media, content-type, archived, removed, favourite, and date filters.
7. Fuse lexical and semantic ranks deterministically and return only canonical database rows.

Semantic-only candidates are therefore eligible for the first result page instead of being discarded merely because BM25 did not return them. Until a relevance cursor contract is implemented, semantic ranking applies to the first page only; a request carrying a lexical cursor returns the safe BM25 page with a `pagination-boundary` semantic status.

When semantic search is disabled, unavailable, paused, over quota, or failed, BM25 remains the complete response path. Provider and sidecar failures are observable through safe diagnostics and are never silently represented as a successful semantic search.

## Status and user experience

The search response carries a small semantic status object and the local UI renders a non-blocking notice near the results:

- `ready`: “Semantic search is ready.”
- `warming`: “Semantic index warming — showing available semantic results.”
- `unavailable`: “Ollama is unavailable — showing keyword results.”
- `error`/`paused`: “Semantic indexing paused — check the local model setup.”

The local status view may show pending item counts, model name, vector count, and last successful indexing time. It may offer “Rebuild semantic index.” It must not expose raw response bodies, attempt to start desktop Ollama, or present local-only status text when the hosted Cloudflare provider is active.

## Failure handling and recovery

- **Daemon unreachable:** classify as `unavailable`, preserve BM25, and retry with bounded exponential backoff.
- **Model missing:** classify as `unavailable`, stop repeated attempts until configuration or model availability changes, and show the documented pull command.
- **Timeout or temporary 5xx:** keep jobs queued and retry.
- **Malformed/non-finite/wrong-dimension response:** reject the batch, write no vectors, and pause the affected generation with a safe error code.
- **Sidecar read/write failure:** preserve BM25 and expose rebuild guidance; never delete canonical library data as automatic recovery.
- **Model/configuration change:** create a new generation, rebuild from canonical items, then activate it atomically; do not mix generations.

## Privacy and security

- Default Ollama traffic is loopback-only.
- The browser cannot choose arbitrary embedding URLs or send raw bookmark text to Ollama directly.
- Hosted Workers ignore local Ollama settings and do not proxy them.
- Sidecar files, model caches, and generated vectors are local ignored state and should inherit the developer's user-account file permissions.
- Logs contain model/status/count/timing metadata, not bookmark bodies, vectors, authorization tokens, or raw provider error bodies.
- A non-loopback Ollama URL requires an explicit developer-only override and a warning that local bookmark text will be sent to that service.

## Testing and evidence boundaries

### Automated tests

- Provider contract tests cover request shape, batching, timeout, missing model, malformed output, non-finite values, and dimension mismatch.
- Sidecar tests cover insert, content-hash replacement, duplicate events, delete, generation rebuild, and deterministic status counts; queue integration tests cover the existing embedding-job retry/lease contract.
- Hybrid search integration proves a semantic-only result is hydrated from D1/SQLite and still obeys every filter and visibility rule.
- Fallback tests prove provider and sidecar failures return BM25 results without a 500 and expose the correct safe status.
- UI tests cover ready, warming, unavailable, and paused/error notices.

The default test suite does not require Ollama, model downloads, Cloudflare credentials, or network access.

### Explicit local smoke test

An opt-in command such as `bun run semantic:ollama` will:

- verify Ollama and the configured model;
- embed a small synthetic corpus using the real model;
- populate the real sidecar and run the real hybrid orchestration;
- include at least one query whose expected semantic match is a BM25 miss;
- report model identity, observed dimension, indexed/pending counts, result IDs, BM25-versus-semantic differences, and elapsed time;
- exit non-zero when a required semantic-only match is missed.

Synthetic text is used instead of private captures. This command is developer-only and is not part of install, CI, or hosted deployment.

### Hosted evidence boundary

The Ollama smoke test proves local provider, sidecar, candidate-union, hydration, filtering, and fallback behavior only. A separate Alchemy/Cloudflare check is required for Workers AI, Vectorize, D1, authentication, quota, and deployed behavior. MCP and CLI remain keyword-only until their paths are deliberately wired and tested.

## Acceptance criteria

1. Local web UI semantic search uses the real Ollama `/api/embed` path when explicitly configured.
2. Local setup is documented and developer-controlled; no hosted user downloads a model or configures Ollama.
3. New bookmarks save immediately, appear in BM25, and are asynchronously indexed when Ollama is available.
4. Ollama-unavailable, warming, and paused states are visible and actionable without blocking keyword search.
5. Sidecar vectors persist across restarts and are isolated by model identity, generation, content hash, and dimension.
6. Semantic-only candidates are unioned, hydrated, filtered, and returned as canonical D1/SQLite rows.
7. Edits, deletes, duplicates, retries, and model changes have deterministic sidecar behavior.
8. Local provider/index failures never turn search into a 500 or leak raw provider details.
9. The default test/build/deployment paths do not require Ollama, model files, or local vector state.
10. Hosted Cloudflare AI/Vectorize behavior and setup remain unchanged and are verified separately.
