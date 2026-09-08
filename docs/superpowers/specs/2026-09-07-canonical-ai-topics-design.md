# Canonical AI Topics for Anansi

**Status:** Approved conversational design; local review copy, intentionally ignored by Git

## Problem

Anansi's current AI tagger stores model strings after trimming and lowercasing. That produces one-off labels, near-duplicates, multilingual labels, and overly specific tags. The sidebar therefore grows as a noisy list instead of becoming a compact navigation surface.

## Product contract

Automatic classification uses a controlled English topic vocabulary:

| ID | Display label |
| --- | --- |
| `web-dev` | Web Dev |
| `ai-ml` | AI / ML |
| `marketing` | Marketing |
| `design` | Design |
| `startups` | Startups |
| `product` | Product |
| `career` | Career |
| `devops` | DevOps |
| `security` | Security |
| `finance` | Finance |
| `health` | Health |

The taxonomy is versioned. A bookmark can receive up to three canonical topics. No automatic output outside the allowlist is written. If the provider returns no valid topic, the job completes without an AI topic rather than inventing `Other` or exposing a noisy label.

Manual tags remain free-form and are never deleted or rewritten by the AI migration.

## Stashr evidence boundary

Stashr's public documentation describes asynchronous, batched AI tagging; reuse of existing tags where they fit; user steering for preferred topics, style, or language; and a high-confidence duplicate-cleanup flow with exact-match fallback when AI is unavailable. It does not disclose a private taxonomy or implementation. Anansi adopts the observable product principles while making the automatic topic layer stricter and deterministic.

Sources: https://stashr.me/docs/ai-tagging and https://stashr.me/docs/tags.

## Architecture

1. `topic-taxonomy.ts` owns the version, stable IDs, display labels, colors, and validation helpers.
2. Ollama's structured JSON prompt lists the IDs and labels and requests IDs only.
3. Workers AI output passes through the same canonicalizer, preserving provider parity.
4. The canonicalizer normalizes exact labels and approved aliases, rejects unknown or non-English free-form output, deduplicates, and caps three topics.
5. `applyAiTags` writes `tags.kind = "topic"` and `item_tags.provenance = "ai"` for canonical topics. User-created labels use `kind = "custom"`.
6. Existing AI assignments are removed and reclassified in resumable batches. Manual item-tag assignments, manual tag rows, overrides, bookmark content, and search indexes remain intact.

## Data model

Add a non-null `kind` column to `tags`, defaulting existing rows to `custom`:

- `topic`: one of the versioned canonical topic rows.
- `custom`: a user-created/manual label or an obsolete legacy AI label retained only if a user still references it.

The API includes `kind`. Topic navigation queries filter to `kind = "topic"`; the tag picker and search can include both kinds. `origin` and item-level `provenance` remain authoritative for manual intent and AI cleanup.

Canonical rows are idempotently seeded/upserted. Re-running migration or a worker cannot duplicate rows or assignments.

## Migration and runtime behavior

- A migration adds `tags.kind` and seeds the canonical topic rows.
- A reclassification command/job clears only AI-provenance assignments to noncanonical labels, then queues each bookmark for the current taxonomy version.
- Existing AI jobs are reconciled without creating duplicate embedding jobs.
- Failed provider calls remain retryable with existing bounded backoff and lease semantics.
- Turning automatic tagging off does not remove existing topics.
- A taxonomy version change queues reclassification; it does not rewrite manual tags.

## UX

- The sidebar presents `Topics`, ordered by active bookmark count, and hides `custom` labels and zero-count topics.
- Cards show up to two canonical topic chips plus `+N` for overflow.
- The tag picker separates `Topics` from `Custom tags` while retaining create/rename/delete behavior for custom labels.
- Settings shows the active taxonomy version, tagging progress, and a resumable reclassification action.
- User steering may influence topic selection but cannot create automatic labels outside the allowlist.

## Testing and acceptance

- Unit tests validate IDs, labels, aliases, multilingual/noisy rejection, deduplication, max-three behavior, and provider parity.
- Database tests validate `kind`, canonical row seeding, manual-tag preservation, AI-assignment replacement, suppression overrides, and idempotent reclassification.
- API/component tests validate topic-only sidebar payloads, picker grouping, card chip limits, progress, and taxonomy-version display.
- Local Ollama smoke and the existing release-readiness E2E prove a bookmark can be imported, tagged with canonical topics, searched through FTS5 and semantic search, and read through MCP.
- Acceptance requires no noncanonical AI labels in the topic rail, no loss of manual tags, repeatable migration, and zero new AI jobs when a worker reconciles the wrong kind.

## Repository hygiene constraint

All `docs/` content is local-only and ignored by Git per the user's repository policy. This spec is intentionally not committed.
