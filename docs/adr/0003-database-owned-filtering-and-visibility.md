# ADR 0003: Database-owned filtering and visibility

- Status: Accepted
- Date: 2026-09-07
- Baseline: `25aed8d`

## Decision

SQLite/D1 is the authority for item identity, visibility, filters, and search
predicates. Every user-facing item query must apply the shared
`visibleSourceClause` in addition to its normal archived/removed/favorite,
author, date, or cursor predicates. HTTP, the library UI, semantic hydration,
CLI, and MCP call database operations rather than reimplementing source hiding
in each transport.

Retained rows are not deleted merely because a source is paused or hidden. A
source may be absent from a catalogue while its old data remains available for
repair, but direct list/search/detail/stats/MCP paths must still be filtered by
the database boundary.

## Context

The current retained/shipped split includes TikTok: its parser and storage
contracts remain useful, but current product surfaces must not expose it. A UI
filter would be bypassable by direct API or MCP calls and would allow different
retrieval paths to drift.

## Consequences

- New retrieval methods must use `visibleSourceClause` (or a database helper
  that applies it) before returning user-facing rows.
- Semantic candidates are hydrated and filtered by D1/SQLite, even when the
  candidate came from Vectorize or the local sidecar.
- Source catalogues and MCP schemas describe the shipped surface but do not
  replace database enforcement.
- Visibility changes are code/test changes at the database boundary and need
  characterization across list, lexical search, semantic search, detail,
  counts, and MCP.

## Rollback

The visibility refactor is stateless: it adds no migration and does not alter
stored rows. Reverting the database predicate and its derived source views is
sufficient to restore the previous query behavior. There is no new item or MCP
wire format to migrate, but reverting only a UI/catalogue caller while leaving
the database predicate (or vice versa) can expose an inconsistent source set;
roll back the database and transport callers as one change and rerun visibility
tests.

## Evidence and verification boundary

The predicate is in [`packages/db/src/visibility.ts`](../../packages/db/src/visibility.ts)
and is used by database query/search paths including
[`packages/db/src/queries.ts`](../../packages/db/src/queries.ts) and
[`packages/db/src/search.ts`](../../packages/db/src/search.ts). Transport callers
are [`apps/web/src/server/api.ts`](../../apps/web/src/server/api.ts) and
[`packages/mcp/src/tools.ts`](../../packages/mcp/src/tools.ts). Existing API,
database, and MCP tests characterize the behavior; the architecture index lists
the focused verification run for the current packet set.

This decision does not imply multi-tenant authorization or a new source. Those
remain separate product and security decisions.
