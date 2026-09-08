# Saved MCP surface implementation plan

## Scope

Implement the approved design in `docs/superpowers/specs/2026-09-08-saved-mcp-surface-design.md`.
No schema migration, provider changes, write permissions, semantic search, or
browser changes.

## 1. Database batch detail seam

- Add a database-level batch detail function beside `getItem` that accepts up
  to 20 IDs, applies the existing visible-source predicate, preserves requested
  order, and returns the same detail shape as `getItem`.
- Keep missing and hidden IDs distinguishable only as `missing_ids` at the MCP
  boundary; never reveal whether a hidden ID exists.
- Avoid N+1 behavior: hydrate common item fields and related media/links/thread
  data with bounded queries or a bounded batch strategy.
- Add database tests for order, duplicates, missing IDs, hidden TikTok rows,
  malformed decoration data, and the 20-ID cap.

## 2. MCP contract rename and registration

- Replace the provisional catalog names with the eight approved names.
- Adapt `search_saved` to the existing keyword search implementation.
- Adapt `get_saved` to the existing single-detail function.
- Add `get_saved_many` over the batch detail seam with a maximum of 20 IDs.
- Adapt `list_saved` to `listItems`, exposing bounded source/author/tag/media,
  content-type, favorite/archive/removed, date, order, and cursor filters.
- Adapt recent and author tools over existing functions with 50-result caps.
- Add `list_tags` and `library_stats` over existing visibility-aware functions.
- Keep output JSON text stable and bounded; describe the search/list/fetch
  workflow in tool descriptions.

## 3. Validation and errors

- Use Zod schemas for all limits, arrays, enums, date strings, cursors, and IDs.
- Reject duplicate or oversized batch IDs and malformed filters with bounded
  errors that do not echo sensitive values.
- Preserve stateless bearer-authenticated HTTP transport and single server
  registration for stdio/HTTP.

## 4. Tests

- Update MCP discovery tests for exactly eight names and all schema caps.
- Add contract tests for each new tool and the renamed existing tools.
- Assert hidden TikTok rows are absent from search, get, batch get, list, recent,
  author, tags, and stats surfaces.
- Assert list cursors and saved/posted order remain stable across pages.
- Assert batch order, missing IDs, duplicate rejection, and full-detail shape.
- Run focused MCP/database tests, then full `bun test`, root typecheck,
  extension compile/build only if the package graph requires it, and
  `git diff --check`.

## 5. Review and handoff

- Review the diff for accidental write/provider/schema scope.
- Record local evidence and the remaining deployment/authenticated acceptance
  boundary in the final response.
