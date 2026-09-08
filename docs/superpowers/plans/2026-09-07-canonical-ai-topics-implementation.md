# Canonical AI topics implementation plan

1. Add `packages/db/src/topics.ts` with the v1 IDs, labels, colors, stable IDs, aliases, and exact canonicalization helpers. Export it from `@anansi/db`.
2. Add `kind` to `tags`, generate migration `0014_canonical_topics.sql`, seed canonical rows, clear only AI-provenance assignments to legacy labels, and reset tagging jobs for resumable reclassification.
3. Update manual tagging and AI application paths so custom tags remain lowercase/free-form, canonical topic aliases resolve to topic rows, and AI writes only `kind = topic` assignments.
4. Update Workers AI and Ollama prompts/parsers to request topic IDs and pass output through the shared canonicalizer. Keep provider errors/retries and the existing async worker contract.
5. Extend the tags API shape with `kind`; make filters/tag picker show topic/custom groups, and add a topic section to the library rail using count-sorted canonical topics.
6. Add migration, canonicalizer, provider, worker, API, and component regression tests; update local E2E/smoke assertions for canonical topics and noisy-label rejection.
7. Run focused tests, full tests, typecheck, web/extension builds, React Doctor, `git diff --check`, and local E2E. Keep all docs changes ignored and uncommitted.
