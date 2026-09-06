# Author-Centric Library UI Implementation Plan

**Date:** 2026-09-06  
**Design:** `docs/superpowers/specs/2026-09-06-author-centric-library-ui-design.md`  
**Goal:** Ship the approved author navigation/grid and card organization UI without changing the canonical `author` filter contract.

## Execution rules

- Preserve all existing dirty work; do not reset, stash, or broad-format the repository.
- Keep one writer per file set and add deterministic tests before behavior changes.
- Keep `author` unchanged in schema, API, URL search, saved views, and MCP contracts.
- Do not delete or rewrite existing media/raw data.
- Treat optional note/tag metadata as decoration: malformed metadata must not block a card.

## Phase 0 — baseline and seams

1. Record `git status --short` and inspect current route/API/query tests.
2. Run the existing focused web/database tests and `bun run typecheck`.
3. Identify the current migration number, tag mutation route, `listTags`, `listItems`, `searchItemsPage`, `ItemRow`, `Card`, `Detail`, `FilterBar`, and creators route seams.
4. Keep failures that predate this plan separate from implementation failures.

## Phase 1 — persisted tag colors and response metadata

### Task 1.1: Add tag color storage

**Modify:** `packages/db/src/schema.ts`, `packages/db/src/queries.ts`, `packages/db/src/index.ts` as needed.  
**Generate:** the next Drizzle migration under `packages/db/drizzle/` and the normalized infra migration when required.

Implement a small named palette and a runtime-portable color assignment function. Assign a color only when inserting a new tag; duplicate labels reuse the existing row and color. Add a safe non-null migration default for older rows. Extend `listTags` to return `{ label, color, count }`.

**Tests:** persistence across reads, duplicate-label reuse, valid palette membership, and migration compatibility.

### Task 1.2: Add card organization metadata

**Modify:** `packages/db/src/search.ts`, `apps/web/src/lib/api.ts`, API response tests.  
**Tests first:** list and search rows expose `hasNote` and colored tag pairs while preserving existing fields and pagination.

Add bounded SQL subqueries/JSON shaping for note presence and per-item tags. Parse malformed optional JSON to empty metadata. Keep `ItemDetail.tags` string-compatible and add colored metadata in a parallel field if needed by detail rendering.

**Verify:** database/search/API focused tests and `bun run typecheck`.

## Phase 2 — author navigation and compact grid

### Task 2.1: Replace inline creator expansion with direct author links

**Modify:** `apps/web/src/routes/creators.tsx` and route tests/helpers.  

Remove selected-author post loading and use TanStack Router navigation to `/?author=<handle>`. Keep platform filtering and author search. Use the total library item count as the percentage denominator and define zero-library behavior without fabricated percentages.

### Task 2.2: Implement responsive author cards

**Modify:** `apps/web/src/routes/creators.tsx`, shared CSS only where necessary, skeletons/tests as needed.

Render 3 columns at desktop, 2 at medium widths, and 1 at narrow widths. Use 34–36px avatars, display name, handle, source mark, saves, exact percentage, and a subtle share bar. Ensure the whole card is a keyboard-accessible link with readable truncation.

**Verify:** route/data tests plus browser checks at desktop, tablet, and 320px widths.

## Phase 3 — card tags and note affordance

### Task 3.1: Build shared tag popover

**Create/modify:** a focused tag-popover component, `apps/web/src/components/card.tsx`, `apps/web/src/components/detail.tsx`, `apps/web/src/components/filters.tsx`, `apps/web/src/components/selectbar.tsx` only where shared types require.

Support existing-tag search/select and create-new-and-attach. Show color dots/chips and counts. Reuse current tag mutation endpoints, invalidate library pages and tag queries after success, and preserve toast errors. Stop card click propagation from controls.

**Tests:** popover normalization, duplicate handling, mutation success/error state, and color rendering.

### Task 3.2: Add note indicator and focus target

**Modify:** `apps/web/src/components/card.tsx`, `apps/web/src/components/detail.tsx`, parent open-item callback in `apps/web/src/routes/index.tsx`.

Render a note icon only when `hasNote` is true. Pass an explicit `focusNote` intent to the detail drawer, focus/scroll the textarea after detail data mounts, and retain normal card-open behavior elsewhere. Preserve accessibility labels and keyboard behavior.

**Tests:** no icon for empty notes, icon for non-empty notes, click intent isolation, and focus-after-load behavior.

## Phase 4 — integration and release verification

1. Run focused DB/API/route/component tests after each phase.
2. Run `bun test`, `bun run typecheck`, `bun run --cwd apps/web build`, and `git diff --check`.
3. Run React Doctor on the changed React surface.
4. Restart the local server against the existing schema, verify migration application, then manually check:
   - creator card navigation to `/?author=...`;
   - 3/2/1-column author layout and 34–36px avatars;
   - tag creation, reload persistence, card filtering, and duplicate reuse;
   - note indicator and note-focused drawer;
   - existing platform/source/author/tag filters and saved views.
5. Report local/static evidence separately from authenticated provider or deployment acceptance.

## Suggested commit boundaries

- `feat(db): persist tag colors and card metadata`
- `feat(web): navigate authors through filtered library`
- `feat(web): add compact card organization controls`
- `test(web): verify author and organization flows`
