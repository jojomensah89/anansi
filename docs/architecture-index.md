# Architecture index

This index is the entry point for implementation-oriented architecture notes.
It records the current durable decisions and the packet evidence that changed
the baseline. The source of truth for behavior is still the code and tests; the
documents below explain boundaries, rationale, and acceptance gaps.

## Baseline and current packets

The improvement guide was written against baseline `25aed8d`. The following
packets have since landed on the current branch:

| Packet | Commit | Evidence in this checkout | Remaining acceptance |
| --- | --- | --- | --- |
| Internal search card projection | `3f2671d`, follow-up `de17253` | `packages/db/src/search.ts` and characterization fixtures in `packages/db/src/search.test.ts`; the focused search suite passed in the verification run below | No external provider gate; retain query/ordering characterization when search changes |
| Source-import lifecycle | `fdc939e` | `createSourceImportLifecycle`, `SourceRuns`, queue ordering, stale-run fencing, cancellation/recovery tests in `apps/extension/lib/source-import-lifecycle.test.ts` and `apps/extension/lib/source-runs.test.ts` | Browser smoke for real X page import and GitHub/Reddit session availability; authenticated provider behavior remains unproven locally |
| Shared AI job execution | `01771e1` | `createAiJobRunner`, model-qualified jobs, bounded reconciliation, lease/content/settings fencing, local semantic/tagging callers, and Ollama adapter tests | Cloudflare Workers AI/Vectorize acceptance, hosted cron/binding behavior, and real Ollama daemon acceptance |
| Source capability views and shared config validation | `31975d7` | Canonical views and fact validation in `packages/sources/src/capabilities.ts`, shared wire validation in `packages/sources/src/extension-config.ts`, and derived catalogue/background/popup/MCP/database consumers; focused capability/config/visibility tests passed in the verification run below | Browser smoke and authenticated provider sessions still remain; extension compile and real config delivery should be included in release acceptance |

## Packet rollback records

- **Internal search projection (`3f2671d`, `de17253`):** code revert is
  sufficient. The commits add no migration, durable projection table, or new
  transport fields; the shared card field names, mode-specific excerpts, and
  cursor encoding remain the existing contracts. Retain the characterization
  tests when reverting implementation code.
- **Source-import lifecycle (`fdc939e`):** code revert is sufficient only
  after active runs are stopped or completed and any run-owned tab is closed.
  IndexedDB remains version 1 and the added `activeTabId`, orphan-tab, and
  run-fenced fields are optional state that older readers can load, but an old
  lifecycle will not perform the new orphan cleanup or pending-save
  acknowledgement semantics. `MESSAGE_PROTOCOL_VERSION` remains 1, but X
  page/done/error events and X backfill commands now require `runId`; the
  exact-key validators reject old X payloads without it and new X payloads with
  it. Rollout or rollback therefore requires reloading/closing existing
  provider tabs and restarting or updating the extension worker; do not allow
  old/new callbacks to mix.
- **Shared AI execution (`01771e1`):** see the durable mixed-identity and
  worker-compatibility rollback record in [ADR 0001](adr/0001-shared-ai-job-lifecycle.md).
- **Source capabilities/config (`31975d7`):** see [ADR 0002](adr/0002-retained-versus-shipped-source-subsets.md).
  Code revert is sufficient for stored rows, but producer/consumer config
  versions should be rolled back together because the new
  `parseExtensionConfig` rejects unknown keys, sources, duplicates, and
  inconsistent facts at the wire boundary.

Focused verification run on 2026-09-07: `bun test` across the six packet suites
(`packages/db/src/search.test.ts`, `packages/db/src/ai-jobs.test.ts`,
`apps/extension/lib/source-import-lifecycle.test.ts`,
`apps/extension/lib/source-runs.test.ts`,
`apps/web/src/server/ai-job-runner.test.ts`, and
`packages/mcp/src/tools.test.ts`) passed **85 tests**. A second AI/local-provider
run covering local semantic worker, local tagging worker, local AI settings,
and Ollama embedding/tagging suites passed **29 tests**. The finalized source
packet's focused run on 2026-09-08 additionally covers `packages/sources/src/capabilities.test.ts`,
`packages/sources/src/extension-config.test.ts`,
`apps/web/src/server/source-catalog.test.ts`,
`packages/db/src/visibility.test.ts`, and the affected API/MCP suites; those
six files passed **47 tests**. The affected extension consumer run
(`apps/extension/lib/popup-connection.test.ts`, `messages.test.ts`,
`source-runs.test.ts`, `packages/sources/src/capture.test.ts`, and
`extension-heartbeat.test.ts`) passed **78 tests**. These are synthetic or
local contract checks, not live-provider or authenticated-browser proof.

## Design guide and durable decisions

- [Architecture improvement guide](architecture-improvement-guide.md) —
  rationale, packet boundaries, acceptance criteria, and rollback guidance.
- [ADR 0001: shared AI lifecycle and projection adapters](adr/0001-shared-ai-job-lifecycle.md)
- [ADR 0002: retained versus shipped source subsets](adr/0002-retained-versus-shipped-source-subsets.md)
- [ADR 0003: database-owned filtering and visibility](adr/0003-database-owned-filtering-and-visibility.md)
- [ADR 0004: keyword-only MCP](adr/0004-keyword-only-mcp.md)
- [Repository README](../README.md) — user-visible source, AI, MCP, privacy,
  and local/hosted behavior.
- [Context glossary](../CONTEXT.md) — names and evidence boundary used by the
  ADRs.

The guide explicitly supersedes the original HTML review's broad search
coordinator and background-controller proposals. Do not revive those as new
public abstractions without a new characterization and decision record.

## Current design specifications and plans

Capture, source, and import:

- [Reliable bookmark capture and sync design](superpowers/specs/2026-09-03-bookmark-extension-sync-design.md)
- [Extension health and Sources truth design](superpowers/specs/2026-09-04-extension-health-sources-truth-design.md)
- [GitHub extension capture design](superpowers/specs/2026-09-04-github-extension-capture-design.md)
- [Bookmark sync implementation plan](superpowers/plans/2026-09-03-bookmark-extension-sync-implementation.md)
- [Extension health implementation plan](superpowers/plans/2026-09-04-extension-health-sources-truth-implementation.md)
- [GitHub capture implementation plan](superpowers/plans/2026-09-04-github-extension-capture-implementation.md)

AI, search, and model boundaries:

- [Cloudflare AI enrichment and TikTok retirement design](superpowers/specs/2026-09-06-cloudflare-ai-enrichment-tiktok-retirement-design.md)
- [Canonical AI topics design](superpowers/specs/2026-09-07-canonical-ai-topics-design.md)
- [Local embedding provider design](superpowers/specs/2026-09-07-local-embedding-provider-design.md)
- [Ollama semantic search design](superpowers/specs/2026-09-07-ollama-local-semantic-search-design.md)
- [Ollama tagging design](superpowers/specs/2026-09-07-ollama-local-tagging-design.md)
- [Local semantic search implementation plan](superpowers/plans/2026-09-07-local-semantic-search-implementation.md)
- [Ollama semantic search implementation plan](superpowers/plans/2026-09-07-ollama-local-semantic-search-implementation.md)
- [Ollama tagging implementation plan](superpowers/plans/2026-09-07-ollama-local-tagging-implementation.md)
- [Canonical AI topics implementation plan](superpowers/plans/2026-09-07-canonical-ai-topics-implementation.md)

Acceptance and product surfaces:

- [Release readiness design](superpowers/specs/2026-09-07-release-readiness-design.md)
- [Alchemy Cloudflare acceptance runbook](superpowers/plans/2026-09-07-alchemy-semantic-smoke-runbook.md)
- [MCP server page design](superpowers/specs/2026-09-04-mcp-server-page-design.md)
- [Extension connection and popup design](superpowers/specs/2026-09-06-extension-connection-popup-design.md)

## Runtime entrypoints and durable seams

| Boundary | Entry point or module |
| --- | --- |
| Hosted Worker and scheduled AI | [`apps/web/src/worker.ts`](../apps/web/src/worker.ts), [`apps/web/src/server/ai-job-runner.ts`](../apps/web/src/server/ai-job-runner.ts) |
| Local AI execution | [`apps/web/src/server/local-semantic-worker.ts`](../apps/web/src/server/local-semantic-worker.ts), [`apps/web/src/server/local-tagging-worker.ts`](../apps/web/src/server/local-tagging-worker.ts), [`apps/web/src/server/local-semantic-cache.ts`](../apps/web/src/server/local-semantic-cache.ts) |
| Web API and source catalogue | [`apps/web/src/server/api.ts`](../apps/web/src/server/api.ts), [`apps/web/src/server/source-catalog.ts`](../apps/web/src/server/source-catalog.ts) |
| Extension host | [`apps/extension/entrypoints/background.ts`](../apps/extension/entrypoints/background.ts) |
| Import lifecycle and durable runs | [`apps/extension/lib/source-import-lifecycle.ts`](../apps/extension/lib/source-import-lifecycle.ts), [`apps/extension/lib/source-runs.ts`](../apps/extension/lib/source-runs.ts), [`apps/extension/lib/capture-queue.ts`](../apps/extension/lib/capture-queue.ts) |
| Shared capture contracts and parsers | [`packages/sources/src/capture.ts`](../packages/sources/src/capture.ts), [`packages/sources/src/item.ts`](../packages/sources/src/item.ts), [`packages/sources/src/index.ts`](../packages/sources/src/index.ts) |
| Canonical source capabilities and extension config | [`packages/sources/src/capabilities.ts`](../packages/sources/src/capabilities.ts), [`packages/sources/src/extension-config.ts`](../packages/sources/src/extension-config.ts), [`apps/extension/lib/popup-connection.ts`](../apps/extension/lib/popup-connection.ts) |
| Canonical persistence and visibility | [`packages/db/src/schema.ts`](../packages/db/src/schema.ts), [`packages/db/src/capture-events.ts`](../packages/db/src/capture-events.ts), [`packages/db/src/ai-jobs.ts`](../packages/db/src/ai-jobs.ts), [`packages/db/src/search.ts`](../packages/db/src/search.ts), [`packages/db/src/visibility.ts`](../packages/db/src/visibility.ts) |
| MCP transport-independent tools | [`packages/mcp/src/tools.ts`](../packages/mcp/src/tools.ts), [`packages/mcp/src/catalog.ts`](../packages/mcp/src/catalog.ts) |

## Finalized source-capability reconciliation

Commit `31975d7` provides the canonical capability rows and derived views. Both
the background host and popup call `parseExtensionConfig` from
`packages/sources/src/extension-config.ts`; the web catalogue, API extension
config, MCP source enum, and database visibility derive membership from the
shared capability exports. The remaining gates are runtime acceptance (real
Chrome, authenticated provider sessions, and deployment/provider behavior), not
an unresolved documentation link.

No ADR here authorizes a product, permission, deployment, or provider change.
