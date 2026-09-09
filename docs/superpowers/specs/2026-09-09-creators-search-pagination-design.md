# Creators search and pagination design

## Goal

Make the creators page scale with the library by moving creator search and
filtering to the backend and loading creator cards through cursor-based
infinite pagination.

## API contract

`GET /api/creators?q=<text>&source=<source>&cursor=<cursor>&limit=<n>` returns:

```json
{
  "creators": [],
  "nextCursor": "...",
  "total": 0
}
```

Repeated `source` parameters mean any selected source. The backend validates
the cursor against the query, source filters, archive policy, and ordering.
Page size is bounded server-side, with a default of 40.

## Backend behavior

- Search `author_handle` and `author_name` in SQL using bound values.
- Apply source visibility, selected source filters, and the default archived
  exclusion before aggregation.
- Group by `(source, author_handle)` so identical handles on different
  platforms remain separate creators.
- Return the maximum available display name, avatar, and posted time for each
  grouped creator, plus its save count.
- Order by save count descending, then source and handle as stable tie-breakers.
- Use a keyset cursor based on the complete ordering and filter identity.
- Run a matching count query so `total` describes the active search/filter
  result, not only the loaded page.

## Frontend behavior

- Replace the one-shot `api.creators(1000)` call with an infinite query keyed
  by creator search text and selected sources.
- Send search and source filters to the endpoint instead of filtering a full
  client-side array.
- Use an intersection sentinel to fetch the next page while preserving the
  existing loading skeleton, retry, empty, and no-match states.
- Reset pages when search text or source selection changes.
- Use the server `total` for the result count and keep the existing stats
  request for library-wide totals.

## Testing

- Query-layer tests cover source-plus-handle grouping, search matching,
  archive exclusion, stable ordering, cursor continuation, and invalid cursor
  rejection.
- API tests cover repeated source parameters, query parameters, pagination,
  totals, and the response shape.
- Route tests cover the infinite query key, filter reset, and next-page
  loading behavior.
- Run focused tests, the web typecheck/build, and `git diff --check`.

## Scope

This change is limited to the creators API/query contract, creators page data
loading and filter controls, and their tests. It does not change the sources
catalog endpoint, library item search, creator card visual design, or the
MCP surface.
