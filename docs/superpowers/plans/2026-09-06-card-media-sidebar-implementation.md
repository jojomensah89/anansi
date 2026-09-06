# Card Media, Tag Overflow, and Collapsible Sidebar Implementation Plan

**Design:** `docs/superpowers/specs/2026-09-06-card-media-sidebar-design.md`
**Date:** 2026-09-06

## Constraints

- Preserve the existing `author` URL/filter contract and tag mutation API.
- Preserve existing dirty worktree changes; do not reset, stash, or broad-format.
- Keep one writer for the shared sidebar/card file set.
- Do not introduce third-party media requests or replace mobile bottom navigation.
- Treat optional metadata as decoration and keep legacy rows renderable.

## Phase 1 — Shared shadcn Sidebar primitive

1. Inspect the installed shadcn/base-ui component conventions in `packages/ui/src/components` and add `sidebar.tsx` through the shadcn-compatible shared package export.
2. Implement the official provider/context, desktop `collapsible="icon"` variant, mobile drawer primitives, menu/button/link composition, trigger, tooltip, and persisted local open state without server or URL state.
3. Extend shared sidebar tokens only as needed; map them to Anansi's existing dark variables.
4. Add focused component tests for expanded/collapsed labels, trigger accessibility, and persistence behavior.

## Phase 2 — Web shell and navigation migration

1. Wrap routed application content in `SidebarProvider` from `apps/web/src/routes/__root.tsx`.
2. Refactor `apps/web/src/components/rail.tsx` to render shadcn Sidebar primitives while keeping its current counts, links, source marks, loading states, and local-library footer.
3. Add `SidebarTrigger` to the sidebar header and tooltips/accessible labels for icon-only mode.
4. Keep the existing mobile bottom navigation CSS/markup at the 640px breakpoint and ensure the desktop Sidebar is hidden there.
5. Verify navigation destinations and counts on Library, Authors, Sources, and MCP routes.

## Phase 3 — Card media and avatar treatment

1. Update `apps/web/src/components/card.tsx` so primary card content has a consistent inner gutter, media is inset with its own radius, and media never touches the outer border.
2. Increase the primary card avatar to 34–36px while preserving local `/api/media/` validation and deterministic fallback initials. Keep repository owner avatars square.
3. Preserve media grid arrangements, lazy loading, poster play indicators, and overflow counts.
4. Add/adjust card tests for media inset styles, avatar sizing, and legacy quote safety.

## Phase 4 — Tag overflow picker and dismissal

1. Refactor `apps/web/src/components/tag-popover.tsx` to support an anchor mode for both `+N` and `+ Add tags`.
2. Render the resting organization row with at most two compact colored tag pills and a native `+N` button. Show `+ Add tags` only on card hover/focus.
3. Render all tags in the portal picker as checkable rows with colored dots and selected state. Reuse attach/remove mutations, duplicate normalization, invalidation, and toast errors.
4. Add pointer-down-outside and Escape dismissal with focus return to the invoking control. Stop event propagation so card opening is unaffected.
5. Add focused tests for overflow opening, checked state, attach/remove calls, outside-click/Escape dismissal, and bounded placement.

## Phase 5 — Verification

1. Run focused card/tag/sidebar tests and `bun run typecheck`.
2. Run `bun test`, `bun run build`, and `git diff --check`.
3. Run React Doctor on the changed React surface and separate new findings from baseline findings.
4. Restart/reuse the local stack and manually verify desktop expanded/collapsed sidebar, 640px bottom navigation, inset media, larger avatars, `+N` picker, outside-click/Escape dismissal, and tag persistence.
5. Report local/static evidence separately from authenticated provider and Cloudflare deployment acceptance.

## Done criteria

- Desktop Sidebar starts expanded and collapses to icon-only with accessible tooltips.
- Mobile retains one bottom navigation surface.
- Card media is visibly inset and rounded; primary avatars are 34–36px.
- Tags match the reference chip treatment; `+N` opens a complete checkbox picker.
- Outside-click and Escape close the picker and return focus.
- All existing tests and production builds remain green.
