# Saved MCP surface

Date: 2026-09-08
Status: proposed; implementation not started

## Goal

Give Anansi's MCP client a compact, read-only interface for finding, browsing,
and understanding the user's saved library. The public vocabulary is `saved`
and `saves`, not the database-internal word `items` and not `bookmarks`, which
would undersell captured repositories, comments, and articles.

## Public tools

The server will expose exactly these eight tools:

| Tool | Purpose | Bound |
| --- | --- | --- |
| `search_saved` | Keyword/BM25 search with source, author, and date filters | 50 results |
| `get_saved` | Full detail for one saved record | one record |
| `get_saved_many` | Full detail for a selected shortlist | 20 IDs |
| `list_saved` | Keyset-paginated library browsing with structured filters | 50 records/page |
| `list_recent_saves` | Newest saved records in bookmark order | 50 records |
| `list_author_saves` | Saved records from one author | 50 records |
| `list_tags` | Visible tag vocabulary and usage counts | bounded by DB result |
| `library_stats` | Visible totals, source/media breakdowns, archive and today counts | one aggregate |

Existing database functions remain authoritative. `list_saved` adapts
`listItems`; `list_tags` adapts `listTags`; `library_stats` adapts
`libraryStats`; single-item detail reuses `getItem`. A batch detail query will
preserve requested ID order and return a separate `missing_ids` list for
unknown or hidden records.

## Filtering and output

`list_saved` accepts source(s), author(s), tag(s), media, content type,
favorite, archived, removed state, date boundaries, order (`saved` or
`posted`), and an opaque `cursor`. It returns card fields and `next_cursor`,
not full bodies. Full bodies are opt-in through `get_saved` or
`get_saved_many`.

Every result passes the existing database visibility predicate. Retained
TikTok rows remain stored and parseable but never appear through MCP. Limits
are enforced by Zod schemas and again at the database boundary.

## Security and behavior

All eight tools are read-only. The existing bearer-authenticated HTTP MCP
endpoint remains stateless. No tool adds writes, exports, collections, semantic
provider calls, or new credentials. Invalid cursors, dates, IDs, and filters
return bounded structured errors without echoing sensitive input.

Tool descriptions should teach the intended workflow: search or list first,
then fetch one or a small shortlist in full. Outputs remain JSON text with
stable field names, source URLs, exact-timestamp indicators, and bounded
thread/media data.

## Testing and acceptance

- `tools/list` advertises exactly the eight names and their limits.
- Search retains keyword behavior and visible-source filtering.
- List filters and both ordering modes preserve keyset pagination.
- Hidden TikTok records remain absent from every tool.
- Batch fetch preserves requested order, reports missing IDs, and never leaks
  hidden records.
- Tags and stats count visible records only.
- Malformed dates, cursors, filters, duplicate/oversized IDs, and excessive
  limits are rejected safely.
- Existing MCP and database tests remain green.
- No schema migration or provider/browser acceptance is required for this
  read-only extraction; local tests do not prove deployed D1 or authenticated
  browser behavior.

## Explicitly out of scope

Semantic search, save/update/tag/archive writes, collection management, media
image rendering, account/quota tools, and MCP resources/prompts remain later
decisions. They require separate provider, authorization, or product design.
