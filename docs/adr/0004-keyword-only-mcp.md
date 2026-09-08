# ADR 0004: Keep MCP keyword-only unless explicitly changed

- Status: Accepted
- Date: 2026-09-07
- Baseline: `25aed8d`

## Decision

The public MCP search contract remains the bounded, keyword-oriented
`search_memory` tool. Its `query` is passed to the database's FTS search with
the existing English stemming/no-fuzzy semantics; its optional `source` filter
contains only visible sources (`x`, `reddit`, `github`, `web`), and output stays
bounded. The other read tools (`get_item`, `recent_saves`, and `find_by_author`)
retain their existing contracts.

MCP does not gain a general search coordinator or a semantic-query mode merely
because the HTTP library search can optionally fuse semantic candidates. A
semantic MCP interface would be a separate, explicit product decision with a
new schema, budget, pagination, privacy, and acceptance review.

## Context

MCP serves agents with a stable, low-surprise read surface. The database search
implementation and web API may evolve internal projections and optional hybrid
ranking, while MCP's keyword-only behavior remains predictable and works when
AI or a vector provider is unavailable.

## Consequences

- Keep MCP schemas, descriptions, bounded limits, visible source filters, and
  keyword behavior characterized in `packages/mcp` tests.
- MCP and HTTP continue to share database visibility and item operations, but
  they do not need identical result fields, ranking, or semantic options.
- Any semantic MCP feature, broad query language, or generic search layer must
  explicitly supersede this ADR and update README/API/MCP documentation and
  acceptance tests.

## Rollback

The keyword-only MCP decision is stateless and has no schema migration. Revert
the MCP implementation/catalogue changes together with any matching tests to
restore the prior public tool behavior. Existing clients may cache tool names
and schemas, so a deployment rollback should keep the same four public names
(`search_memory`, `get_item`, `recent_saves`, `find_by_author`) and bounded
keyword arguments; introducing a semantic or renamed tool is a deliberate wire
change, not an automatic rollback step.

## Evidence and verification boundary

The public catalog is in [`packages/mcp/src/catalog.ts`](../../packages/mcp/src/catalog.ts),
the implementation/schema in [`packages/mcp/src/tools.ts`](../../packages/mcp/src/tools.ts),
and the database contract in [`packages/db/src/search.ts`](../../packages/db/src/search.ts).
The MCP tool contract suite passed in the focused verification run recorded in
[`docs/architecture-index.md`](../architecture-index.md). Semantic HTTP search
and local/hosted AI remain independent optional paths.
