# Unified Loading Skeletons Design

**Date:** 2026-09-07
**Status:** Approved for implementation
**Scope:** Replace content-loading text and dot indicators with consistent skeleton placeholders across the web app, including smaller panels.

## Goal

Every content-fetch loading state in the web app should use the existing skeleton visual language. The user should see a shape that matches the content arriving rather than a mixture of `Loading…`, `Searching…`, and an isolated dot.

## Design

Extend `apps/web/src/components/skeleton.tsx` with purpose-shaped, reusable placeholders for the router pending page, Settings page, Saved Views panel, search palette results, and the compact load-more row. The session gate uses the neutral page skeleton while authentication is being checked; its connection card appears only after the server confirms the browser is unauthenticated. Existing creator metadata and rail counts should also remain skeletonized until their first response is ready. Each placeholder uses `Bone` and the `Loading` wrapper so visual decoration stays hidden from assistive technology while the region announces one accessible loading label.

Each route or panel keeps the existing delayed-display behavior where applicable (`useSlowLoad`), preventing a skeleton from flashing during a fast local response. Error, empty, and mutation-progress states remain semantically distinct. Button operations such as connecting or exporting may retain concise action labels because they do not correspond to content being fetched.

## Verification

- Component tests cover the new skeleton variants and their accessible loading labels.
- `rg` confirms content-fetch loading copy is removed from the affected surfaces.
- Existing full tests, typecheck, production build, and `git diff --check` remain green.
