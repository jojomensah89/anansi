# Author-Centric Library UI Design

**Date:** 2026-09-06  
**Status:** Approved design; implementation pending

## Goal

Make the existing Authors/Creators and Library surfaces denser and more useful while keeping `author` as the canonical database, API, URL, and filter term. An author row should be a direct path into the filtered library. Cards should expose lightweight organization state (tags and private-note presence) without loading full detail content.

## User-facing behavior

### Author navigation and terminology

- The dedicated creators route continues to list all authors and their source identity.
- Each author card is a single link to the library with the existing `author=<handle>` search state.
- The destination library owns filtering and renders its normal Author filter chip.
- The creators page uses “Author”/“authors” in labels, placeholders, summaries, and accessible names. “Creators” may remain as the navigation/page title where it is already established, but it is not a second filter key.
- Inline author expansion and its secondary item fetch are removed; browser history and shareable URLs become the navigation model.

### Compact author grid

- Authors render as compact cards in a responsive 3-column desktop grid, 2-column medium grid, and 1-column narrow/mobile grid.
- Each card includes a 34–36px avatar, display name, `@handle`, source mark, save count, percentage of the full library, and a subtle share bar.
- The exact save count and percentage remain visible as text. Percentages use the unfiltered library total, not the current author search result.
- The whole card is keyboard-accessible and navigates to the filtered library.

### Card organization affordances

- Library cards show colored tag chips and a compact “+ Add tags” footer control.
- The tag popover supports searching existing tags, selecting an existing tag, and creating a new tag when no matching label exists. New tags receive one randomly selected Anansi palette color at creation time.
- Tag color is persisted and reused consistently in cards, the detail drawer, and the tag filter. Labels remain normalized as they are today.
- A note icon appears only when a private note is non-empty. Selecting the icon opens the existing detail drawer and focuses the note editor; selecting the rest of the card preserves normal card-open behavior.

## Data and API contract

- Add a migration adding `tags.color` with a non-null safe default for existing rows.
- Tag creation/attachment is centralized in the existing server mutation path, extended to return the created tag’s label and color where useful. Duplicate labels reuse the existing row and color.
- `listTags` returns `{ label, color, count }`.
- Library/search rows gain lightweight organization metadata: `hasNote` and tag `{ label, color }` pairs. Full note text remains detail-only.
- `ItemDetail.tags` remains backward-compatible for existing consumers; a parallel colored tag metadata field may be added where needed rather than changing the meaning of the current string list.
- Existing `author` query parsing, SQL filtering, saved views, and MCP/API contracts remain unchanged.

## Components and boundaries

- `routes/creators.tsx` owns author-grid presentation and link construction; it does not duplicate library filtering logic.
- `components/card.tsx` owns compact metadata rendering and event boundaries for tag/note controls.
- A small tag-popover component owns search/create/select interaction and calls the shared API mutation.
- `components/detail.tsx` consumes the same tag color data and exposes a note focus target.
- Database query functions own color assignment, normalization, duplicate reuse, and response shaping; random assignment happens only at creation, never during rendering.

## Error and loading behavior

- Existing loading skeletons remain; no fabricated counts, percentages, colors, or note state are shown before authoritative data arrives.
- Tag mutation failures leave the current card unchanged and use the existing toast/error pattern.
- A malformed or missing legacy tag color falls back to the migration default; a malformed optional card metadata field must not prevent the item from rendering.
- A note-focus request that arrives before detail data is loaded is applied once the drawer content mounts.

## Verification and acceptance criteria

- Clicking an author navigates directly to `/?author=<handle>` and the library shows that author filter.
- Author cards are 3/2/1 columns at desktop/medium/narrow widths, with readable 34–36px avatars and visible saves plus percentage.
- Creating a tag assigns one persisted color; reloading and viewing the tag elsewhere retains it. Duplicate creation does not change the original color.
- Existing and new tag chips render their stored colors in cards, detail, and filters.
- Adding/removing a tag from a card updates the card and filter counts without a full reload.
- Note icons appear only for items with notes and focus the note editor when activated.
- Existing author/source/tag filtering and saved views continue to work.
- Focused tests cover navigation, percentage calculation, responsive data, color persistence, duplicate tags, tag mutations, note indicators/focus, and response compatibility.
- Full tests, typecheck, web build, and React Doctor pass; manual QA covers desktop, tablet, and 320px layouts.

## Scope boundary

This change does not rename the underlying author field, create author profile routes, add arbitrary tag color editing, redesign the detail drawer, or delete existing media/raw data. It is a focused extension of the current library and organization model.
