# Release Readiness and End-to-End Acceptance Design

**Date:** 2026-09-07
**Status:** Approved

## Goal

Make Anansi's public repository honest and reproducible before launch. The
release pass covers the local capture, AI enrichment, FTS5/BM25, semantic,
CLI, and MCP paths; aligns the OSS documentation with the current one-origin
development workflow; and provides an opt-in Cloudflare acceptance procedure
that uses an isolated Alchemy stage and synthetic data.

## Scope

- Add a repeatable local end-to-end smoke path that creates isolated data,
  exercises authenticated ingest, waits for local Ollama tagging/embedding,
  checks exact and semantic search, and checks HTTP and stdio MCP contracts.
- Correct contributor and extension setup instructions to use the public local
  origin (`127.0.0.1:3001`) and the build-time extension credential.
- Explain FTS5/BM25 versus semantic search, including fallback behavior and the
  evidence boundary between local Ollama and hosted Cloudflare services.
- Align MCP source-filter schemas and descriptions with visible sources:
  `x`, `reddit`, `github`, and `web`. TikTok remains hidden while paused.
- Add package/repository metadata needed for a readable public monorepo without
  making internal workspace packages accidental npm artifacts.
- Document an opt-in Cloudflare acceptance run using a unique stage,
  synthetic records, explicit quota warning, and stage teardown.

## Non-goals

- No authenticated provider import is faked or claimed from synthetic data.
- No production Cloudflare deploy, billing change, or destructive cleanup.
- No automatic Cloudflare test in CI or the default test command.
- No MCP semantic-search behavior change; MCP remains keyword/BM25 until a
  separate design deliberately wires hybrid retrieval there.

## Acceptance

The local smoke must prove capture receipt/idempotency, AI tag persistence,
embedding completion, exact FTS5 results, a semantic-only result, and both MCP
transports. Documentation must not advertise internal port `8788`, popup token
entry, or unverified Cloudflare behavior as a completed feature. The Cloudflare
runbook must state what remote calls and resources it exercises and how to
destroy only its named stage.
