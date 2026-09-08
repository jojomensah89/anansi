# Ollama Local AI Tagging Implementation Plan

Based on `docs/superpowers/specs/2026-09-07-ollama-local-tagging-design.md`.

## Work order

1. Add a provider-neutral tag-generation contract and Ollama `/api/chat` adapter.
2. Centralize AI tag assignment and add a local durable tagging worker.
3. Wire local server configuration, API capability/toggle handling, and Settings UI.
4. Add provider, worker, API, and smoke coverage.
5. Run focused tests, full checks, build, and diff validation.

## Files and contracts

- `apps/web/src/server/ai.ts`: `TagGenerationProvider` and shared strict tag normalization.
- `apps/web/src/server/ollama-tagging.ts`: timeout-safe Ollama chat adapter with JSON schema output.
- `packages/db/src/ai-jobs.ts`: shared idempotent `applyAiTags` helper.
- `apps/web/src/server/worker` equivalent local module: bounded tagging claims and retry handling.
- `apps/web/scripts/serve-local.ts`: `OLLAMA_TAG_MODEL`, provider construction, worker scheduling, and API nudges.
- `apps/web/src/server/api.ts` and `apps/web/src/routes/settings.tsx`: local tag-provider capability and independent toggle.
- Focused tests plus `scripts/ai-tagging-ollama-smoke.ts`.

## Verification gates

- Fake-provider tests cover valid/invalid model output, injection text, retries, suppression, and idempotence.
- Live smoke uses only synthetic text and the local Ollama model.
- Existing semantic, hosted AI, ingest, MCP, typecheck, production build, and full test suites remain green.
- No deployment or provider-account claim is made from local evidence.
