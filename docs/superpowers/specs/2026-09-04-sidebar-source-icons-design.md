# Sidebar source icons

## Request and observed state

The sidebar's Sources section currently renders text badges (`x`, `gh`, `r/`,
`tt`, and `www`) beside each source label and count. The attached screenshot is
a visual reference for the requested result; it is not additional
implementation instructions.

The user wants the sidebar to use the source icons already used elsewhere in
the web UI.

## Chosen approach

Replace each text badge with the shared `SourceMark` SVG component. Keep the
existing 22px icon slot, source labels, counts, loading placeholders, link
targets, and source ordering unchanged. The source mark's explicit colors make
Reddit orange, TikTok cyan, and web blue while keeping X and GitHub neutral and
visible on the dark rail.

## Boundaries and data flow

- Change only the sidebar presentation in `apps/web/src/components/rail.tsx`.
- Reuse `SourceMark`; do not duplicate SVG paths or introduce a sidebar-only
  icon registry.
- Remove the obsolete text-tag field from the source row data.
- Keep `bySource` counts and the existing delayed-loading behavior unchanged.
- Keep each source row's filtered-library URL and source order unchanged.

## Accessibility and layout

`SourceMark` retains its source-specific accessible label. The visible source
name remains next to the icon, so the icon is a reinforcing cue rather than the
only source identifier. The fixed-width slot prevents count alignment from
changing when icons have different intrinsic shapes.

## Verification and acceptance criteria

1. The Sources section renders the shared X, GitHub, Reddit, TikTok, and web
   icons instead of `x`, `gh`, `r/`, `tt`, and `www` text badges.
2. Reddit, TikTok, and web icons retain their explicit colors; X and GitHub
   remain visible neutral marks.
3. Labels, counts, loading states, row order, and source-filter navigation are
   unchanged.
4. Existing avatar/source-mark behavior remains unaffected.

Run focused formatting/tests, the full test suite, the web production build,
and `git diff --check`. Report any unrelated baseline diagnostics separately.
