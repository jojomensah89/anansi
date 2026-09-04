# Reddit avatar fallback and coloured source marks

## Request and observed state

The Reddit cards and item detail view show a blank grey author circle when no
avatar URL is available. Reddit saved listings currently do not provide a
profile avatar in the normalized item produced by the importer, and the web
card's existing colored-initial fallback is not given the author handle. The
detail drawer and quoted-item row use separate grey-only fallbacks.

The user asked for both missing Reddit avatars/logos and colored platform
marks. The attached screenshots are visual references for the reported state;
they are not additional implementation instructions.

## Chosen approach

Use a local, deterministic fallback rather than adding Reddit profile lookups.
When a real stored avatar URL exists, keep rendering it unchanged. When it is
missing, render the first character of the available author handle or name on a
stable color derived from that label. The same fallback component must be used
by cards, the detail drawer, and quoted-item rows so the treatment is
consistent.

Give each platform mark an explicit color: Reddit orange, TikTok cyan, web a
cool blue, and the existing neutral light treatment for X and GitHub. The
source mark remains an icon-only label with its existing accessible label.

## Boundaries and data flow

- Do not change the normalized source contract, Reddit importer, database
  schema, or media storage.
- The avatar fallback consumes the already available author avatar, author
  handle, and author name fields at the UI boundary.
- The fallback seed is normalized by trimming a leading `@`; an absent seed
  continues to render a neutral placeholder rather than inventing an author.
- Real avatar images remain lazy-loaded and keep their current shape: circular
  for people and rounded-square for repositories.
- Source colors are presentation-only and do not alter filtering, persistence,
  or source identity.

## Error handling and accessibility

An absent avatar is a normal source limitation, not an error. It must not
trigger a network request or show a broken-image indicator. Initial-only
fallbacks are decorative because the surrounding author text remains the
accessible name. Source SVGs retain their existing `aria-label` values and
inherit the surrounding color only when explicitly rendered muted.

## Verification and acceptance criteria

Focused verification should cover:

1. A Reddit item without `authorAvatar` renders a non-grey initial fallback in
   both the card and detail contexts.
2. The same author seed produces the same fallback color across renders, while
   different seeds can be distinguished.
3. A missing seed still renders a neutral placeholder.
4. Quoted-item avatars use the same fallback behavior.
5. Reddit, TikTok, and web source marks receive their explicit colors, while
   X and GitHub remain visible and neutral.
6. Existing real avatar URLs, repository square avatars, source icons,
   filtering, and persisted data remain unaffected.

Run focused tests/typecheck for changed web components, `git diff --check`, and
React Doctor after the implementation. Any unrelated pre-existing repository
diagnostics must be reported separately from changed-file results.
