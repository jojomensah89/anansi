# ADR 0001: Shared AI job lifecycle with separate projection adapters

- Status: Accepted
- Date: 2026-09-07
- Baseline: `25aed8d`
- Implemented by: `01771e1` (`refactor(ai): share durable job execution`)

## Decision

Use one framework-independent `createAiJobRunner` for the durable lifecycle of
both `embedding` and `tagging` jobs. The runner owns bounded claim/load/execute/
acknowledge/fail ordering and rechecks the current item content hash, active
model/toggle, and claim lease before publishing. `packages/db/src/ai-jobs.ts`
remains the authority for reconciliation, leases, retry/backoff, transitions,
and model-qualified job identity.

Keep projection adapters separate. An executor provides provider-only `prepare`
and projection-specific `publish` operations. Hosted Workers AI, local Ollama,
Vectorize, and the SQLite semantic sidecar can therefore vary independently.
Local sidecar repair, generation replacement, status publication, and canonical
tag suppression stay outside the shared runner. Timers, cron, and request nudges
remain runtime concerns.

## Context

Before this change, hosted execution, local tagging, and local semantic search
each repeated parts of the same job lifecycle while their projection and repair
needs differed. A single universal provider abstraction would hide those
differences and would couple browser/Worker code to `bun:sqlite`.

## Consequences

- New AI kinds must use the durable runner and supply an explicit projection
  adapter; they do not copy lifecycle code into a runtime entrypoint.
- A failed required projection cannot be acknowledged as complete. Remote
  projection and database acknowledgement are not one atomic operation, so
  adapters must be idempotent and tests must cover recovery.
- Model changes and content edits create or expose new qualified work rather
  than reusing a terminal result for the wrong generation.
- Local semantic repair remains able to rebuild a deleted sidecar without
  making the canonical database depend on sidecar availability.

## Rollback and mixed-version safety

`01771e1` changes durable job identity without changing the
`ai_enrichment_jobs` table schema. Tagging rows written before the change use
`tagging:<itemId>:<contentHash>`; new rows use
`tagging:<model>:<itemId>:<contentHash>`. `reconcileAiJobs` recognizes the old
form and retires at most 20 legacy rows per pass. When the active AI projection
is current, it first carries that completion to the qualified row, then removes
the legacy row; otherwise the qualified row is allowed to be queued normally.
This makes migration progressive and bounded, and mixed old/new rows are
expected while cleanup runs.

Because the table columns are unchanged, an old binary can read the new rows,
but an old worker has no model-prefix claim filter and is not a safe concurrent
rollback target across an embedding- or tag-model change. Before rolling back
or running old workers, pause the AI schedule, inspect legacy and
model-qualified rows plus the current tag/embedding projections, and let one
version drain or explicitly reconcile them. A code revert alone is not a
durable rollback: it can recreate unqualified tagging rows or process a
qualified embedding or tagging row under the wrong active model. Resume only
after the queue/projection state has been reviewed; do not delete job rows
blindly.

## Evidence and verification boundary

The implementation and tests are in [`apps/web/src/server/ai-job-runner.ts`](../../apps/web/src/server/ai-job-runner.ts),
[`packages/db/src/ai-jobs.ts`](../../packages/db/src/ai-jobs.ts), and the related
local worker/provider files. The focused runner/database suites passed, as did
the local semantic/tagging/settings and Ollama adapter suites (see the packet
record in [`docs/architecture-index.md`](../architecture-index.md)). This does
not prove hosted cron, Cloudflare bindings, or a real Ollama daemon; those stay
release acceptance gates.

The guide's shared-runner proposal is now implemented. Any later change to job
generations, fencing, or durable schema requires a compatibility and rollback
record rather than a silent lifecycle rewrite.
