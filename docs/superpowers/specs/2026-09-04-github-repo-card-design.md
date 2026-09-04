# GitHub repository card design

## Goal

Present every GitHub item in the library as a recognizable repository card,
following the supplied reference: a dark Anansi card containing a white,
GitHub-style repository preview. The treatment applies to starred repositories
already imported and to future GitHub captures. Other source cards keep their
current layout.

## Visual contract

The existing card remains the outer interaction surface. A GitHub card contains:

1. An Anansi header with the owner avatar, owner handle, and the source mark.
2. The repository title (`owner/name`) and the stored description/README
   excerpt, clamped to the available card height.
3. A white repository preview panel with the repository name, owner avatar,
   repository URL affordance, GitHub mark, and compact repository statistics.
4. A language-colored strip along the preview panel's lower edge when GitHub
   supplied a language.
5. The existing saved date, selection state, and “unsaved at source” state.

The preview panel is visual decoration of the saved item, not a live embedded
GitHub page. Opening the card continues to open Anansi's detail view. Long or
missing values must truncate or disappear cleanly without changing the card's
height contract for other sources.

## Data contract

The GitHub parser already persists the repository title, owner/avatar,
description plus README body, repository URL, language, and metrics for stars,
forks, open issues, and watchers. The list endpoint should expose only the
stored language as an optional top-level field alongside the existing card
fields; it must not return the raw provider payload.

The card renders available metrics using stable labels. It must not fabricate a
contributors count: GitHub starred-repository responses do not currently store
that value. If a metric is absent or zero, the component may omit it according
to the existing compact-metadata convention. A missing language uses the
neutral preview strip rather than a guessed color.

## Component boundary

Keep `Card` as the shared interaction and state boundary. Branch on the
normalized source once and delegate GitHub-only markup to a focused
`GithubRepoCard` presentation component (or an equivalently isolated local
component). The component receives the normalized `ItemRow` and the existing
selection/open callbacks; it does not fetch GitHub, parse raw JSON, or own
navigation.

Add a small language-color mapping with a neutral fallback. The mapping is
source-presentation data and should be independently testable. The repository
preview should use local SVG/text marks already used by Anansi rather than
loading a remote image or iframe.

## API and persistence flow

`parseStarredPage` continues to write the language inside the preserved raw
metadata. The database list projection extracts that one value for GitHub
cards. `ItemRow`/`SearchHit` gains an optional language field so the web card
can render it without broadening the API to raw metadata. Existing search,
detail, and non-GitHub rows remain compatible because the field is optional.

## Interaction and error handling

- The outer card keeps its current click behavior for opening or selecting.
- The repository URL is shown as an affordance but does not cause a second
  navigation target inside the clickable card.
- The preview remains useful if the avatar fails, the description is empty, or
  one or more metrics are missing; existing deterministic avatar fallback and
  neutral source styling handle those cases.
- No network request is made while rendering a card, so provider outages or
  deleted repositories do not blank an already-saved item.

## Verification and acceptance criteria

- GitHub items render the dark-shell/white-preview composition shown by the
  supplied reference.
- Non-GitHub cards render as before.
- Language is shown with the correct mapped color when present and neutral
  styling when absent or unknown.
- Repository title, owner, description/README excerpt, URL affordance, and
  available stars/forks/issues/watchers are rendered from stored data only.
- Selection, opening the detail view, saved date, and unsaved state still work.
- Unit tests cover the language-color mapping, optional metadata, and the
  GitHub card's key render states.
- The full test suite, web production build, type checks, `git diff --check`,
  and scoped React Doctor check pass. Any unrelated pre-existing React Doctor
  warnings are reported separately.

## Out of scope

- Fetching additional GitHub data at card-render time.
- Adding contributor counts or other metrics not already persisted.
- Embedding a live GitHub page.
- Redesigning Reddit, X, TikTok, web, or generic cards.
