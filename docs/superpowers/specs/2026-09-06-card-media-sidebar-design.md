# Card Media, Tag Overflow, and Collapsible Sidebar Design

**Date:** 2026-09-06
**Status:** Approved for implementation

## Goal

Bring the library cards and navigation in line with the supplied visual references while preserving Anansi's existing data contracts, dark visual language, and mobile navigation.

## Scope

This change covers four related presentation interactions:

1. Card media is inset from the card edge and uses rounded corners.
2. Card authors use a larger primary avatar and organization metadata uses compact tag pills.
3. The tag overflow chip opens a complete, checkable tag picker; outside-click and Escape dismiss it.
4. The hand-built desktop rail becomes the official shadcn Sidebar with expanded and icon-only states; mobile keeps its bottom navigation.

The existing `author` URL/filter contract, tag mutation endpoints, card opening behavior, source counts, and persisted tag colors remain unchanged.

## Card layout

Every non-repository card keeps its outer border and radius, but its content receives a consistent 10–12px inset. Media sits inside that content gutter, has its own 8–10px radius, and never touches the card border. The media grid keeps its existing one-to-four item arrangements, lazy loading, local media URLs, video poster affordance, and overflow count.

The primary author row uses a 34–36px circular avatar. Stored avatars continue to accept only local `/api/media/` URLs; other or missing values use the deterministic initial fallback. GitHub repository cards keep their square repository-owner treatment, with the larger size applied only where it improves the primary card header.

The organization row follows media and uses compact pills: a 6–7px colored dot, the tag label, and a dark neutral surface. At rest, show the first two tags and an overflow chip such as `+1`. The overflow chip is a real button. The separate `+ Add tags` affordance is hidden in the resting state and appears on card hover/focus; it opens the same picker.

## Tag picker

The picker is one shared component used by card organization controls. It is anchored to the clicked chip/button and rendered through a document-body portal so card overflow cannot clip it. Placement is bounded to the viewport and is recomputed on resize and scroll.

The open picker contains a search field and the full tag catalogue. Each row is a native checkbox/button control with its persisted color dot and label. Tags already attached to the item are checked. Selecting an unchecked tag attaches it; clearing a checked tag removes it through the existing item-tag mutation API. Duplicate creation remains normalized by the existing server/database path. Mutation success invalidates the affected library pages and tag catalogue; failures remain visible as a toast.

Pointer-down outside the picker and anchor closes it. Escape closes it and returns focus to the triggering control. Pointer and keyboard events are stopped at the organization controls so opening or changing tags never opens the card detail.

## Sidebar architecture

Add the official shadcn Sidebar primitives to `@anansi/ui` and import them into the web app. The root route provides one `SidebarProvider` around the routed application. The existing `Rail` component remains the owner of Anansi navigation data and counts, but renders the shadcn structure:

- `Sidebar` with `collapsible="icon"`, default expanded state, and the existing dark token mapping;
- `SidebarHeader` containing the Anansi mark and `SidebarTrigger`;
- `SidebarContent` groups for Library, Authors, Sources, MCP, and source-filter links;
- `SidebarFooter` for local-library status;
- `SidebarMenuButton` links using the existing TanStack Router destinations.

Collapsed mode retains icons and accessible labels, hides text/counts, and supplies tooltips. The open state is stored locally and restored after reload without adding server or URL state. At the mobile breakpoint, the desktop Sidebar is hidden and the current four-item bottom navigation remains the only navigation surface.

## Error and compatibility behavior

Optional tag and media metadata are decoration. Missing, malformed, or legacy shapes render neutral fallbacks and never prevent the card grid from loading. A failed tag catalogue request leaves the current card usable and reports the mutation/catalogue error without closing unrelated library interactions.

## Verification and acceptance

- Component tests cover compact tag rendering, `+N` opening/selection state, outside-click/Escape dismissal, larger avatars, and media inset styles.
- Sidebar tests cover expanded/collapsed rendering, persisted state, link destinations, accessible labels/tooltips, and mobile navigation visibility.
- Existing full tests, typecheck, production web/extension builds, and `git diff --check` remain green.
- Browser checks cover desktop expanded/collapsed sidebar, 640px mobile navigation, card media gutters, 34–36px avatars, tag overflow picker dismissal, and tag attach/remove persistence.

## Non-goals

- No change to database identity, API query contracts, URL filter names, or tag color assignment.
- No new third-party media requests.
- No replacement of the mobile bottom navigation with a drawer.
- No broad visual rewrite of detail, repository, or source pages beyond the shared sidebar/card seams.
