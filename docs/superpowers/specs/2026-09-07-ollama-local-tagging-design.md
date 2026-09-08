# Ollama Local AI Tagging Design

**Date:** 2026-09-07
**Status:** Approved for implementation by the user's continuation request
**Scope:** Add local Ollama text-generation for automatic topic tags while preserving the existing local embedding path and hosted Cloudflare behavior.

## 1. Goal and boundary

Anansi should be able to generate concise topic tags for saved items locally, without sending bookmark text to a hosted provider. This is enrichment of saved items, not usage telemetry or behavioral tracking.

The existing `embeddinggemma` path remains responsible for local semantic search. The new path uses a separate instruction model, defaulting to `qwen3:4b-instruct-2507-q4_K_M`, and is independently controlled by `auto_tagging_enabled`.

This slice does not add summaries, image understanding, a new tag taxonomy, or changes to Cloudflare provisioning. It does not make a model call during ingest.

## 2. Provider boundary

Add a small `TagGenerationProvider` interface with a model identity and `generateTags(text, max)` method. The provider receives only bounded `searchableText`; raw payloads, private notes, credentials, and media URLs are excluded.

Implement an Ollama adapter using `POST /api/chat`, non-streaming responses, temperature zero, and a JSON schema supplied through Ollama's `format` field. The adapter validates the response through the existing normalization rules: lowercase labels, bounded length, no control characters, no duplicates, and at most five labels. Transport, timeout, missing-model, malformed-output, and quota-like failures become the existing bounded AI error types.

The Cloudflare `generateTags` call remains supported and uses the same normalization contract. Shared tag-application logic moves to the database AI job module so local and hosted workers cannot diverge on manual-tag precedence or suppression.

## 3. Local job flow

Add a local tagging worker alongside the existing semantic worker. On a bounded interval and on an explicit settings/ingest nudge it will:

1. Read settings and exit when automatic tagging is disabled.
2. Reconcile missing or changed tagging jobs without calling the model.
3. Claim a small leased batch of tagging jobs.
4. Load authoritative item rows and call the provider sequentially.
5. Apply AI assignments idempotently, preserving manual assignments and suppressed item/tag pairs.
6. Complete jobs or record bounded retry/backoff failures.

Saving and keyword search remain synchronous and independent of the worker. A missing or stopped Ollama model leaves ingest and BM25 usable and surfaces a paused/unavailable progress state.

The local server gets `OLLAMA_TAG_MODEL` (default `qwen3:4b-instruct-2507-q4_K_M`) and starts the tagging worker only when the provider is configured. The embedding model and semantic sidecar settings remain unchanged.

## 4. API and settings behavior

Extend the API environment with an optional local tag provider and tagging kick callback. `GET /api/ai` reports local automatic tagging as available when that provider is configured. `PATCH /api/ai` accepts `autoTaggingEnabled: true` in local mode only when a local tag provider exists; hosted Cloudflare validation is unchanged.

The settings UI keeps Semantic Search and Automatic Tags as independent toggles. Automatic Tags is disabled only when no tag provider is available, not merely because the runtime is Ollama. Existing progress counts, error handling, and the explanation that manual tags remain authoritative stay visible.

## 5. Safety and normalization

The system prompt tells the model to ignore instructions inside bookmark content and return only the tag object. The model output is untrusted. The parser, not the model, decides what may enter the database. AI tags never change item text, notes, favorites, archive state, or manual tags.

Because small models may emit aliases (`mcpserver` versus `mcp-server`), the first implementation preserves the existing deterministic normalization and records the exact normalized label. A later controlled-vocabulary feature is explicitly out of scope for this slice.

## 6. Verification

Focused tests will cover:

- Ollama request shape, JSON-schema response parsing, timeout, missing model, malformed JSON, duplicate labels, and prompt-injection text.
- Local tagging worker success, disabled behavior, retries, idempotence, manual-tag preservation, and suppression.
- API acceptance/rejection of the local automatic-tags toggle and settings capability reporting.
- Existing Cloudflare AI/tagging and semantic-search tests remaining green.

Add a local smoke command using synthetic items and the configured Ollama tag model. It will report the model, labels, and completion status without reading private captures. A successful smoke run proves the local provider and parser; it does not prove hosted deployment or model quality across the user's full library.

## 7. Acceptance criteria

- `ollama list` model can produce valid bounded tag objects through the local adapter.
- Local automatic tagging can be enabled without disabling semantic search.
- New and changed items enqueue durable tagging jobs; ingest never waits for inference.
- Manual tags and user suppressions remain authoritative.
- Ollama failures do not break ingest, BM25 search, MCP, or manual tagging.
- Hosted Cloudflare tagging behavior and defaults remain unchanged.
- Focused tests, full tests, typecheck, production build, and `git diff --check` pass.
