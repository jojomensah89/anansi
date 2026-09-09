# Extension Import All Design

**Status:** Approved design; implementation pending

## Goal

Give first-time extension users one clear action that starts the existing full
imports for every configured platform source at once. The action should be a
small convenience over the existing per-source Import buttons, not a new
import system.

## Scope

- Add an `Import all` action to the extension popup.
- Start the existing full-import action for X, Reddit, and GitHub together.
- Keep each source's existing durable run, progress, retry, pause, and error
  behavior.
- Keep Chrome bookmark mirroring/import separate because it is an explicit
  permission-sensitive opt-in.
- Preserve the existing individual source Import buttons.

## Non-goals

- Adding an aggregate or batch import record.
- Adding aggregate progress, a new queue, or a new import lifecycle.
- Changing source-specific import behavior, limits, retry policy, or storage.
- Automatically enabling or importing an unconfigured source.
- Including Chrome bookmarks in the `Import all` action.

## User experience

The popup places `Import all` above the platform source rows. It is available
for first-time setup while at least one configured platform source has not
completed its initial full import. It is hidden once all configured platform
sources have completed that initial import. If the configuration or durable
snapshot is not available, the popup does not guess the completion state.

The button has one simple meaning: call the existing Import action for each
configured platform source at the same time. It does not replace the row-level
buttons, and it does not present a second progress model. Each row remains the
source of truth for running, paused, failed, and completed status.

## Message and background behavior

Extend the popup command message union with an `import-all` command. The
background handler resolves the configured, enabled platform sources and
invokes the same existing `startCapture(source)` path used by each row's
Import button for X, Reddit, and GitHub. The calls are started together and
are isolated so a failure in one source does not prevent the other sources
from starting.

The command acknowledges launch rather than waiting for the complete history
of every source. Existing background recovery and source-run persistence remain
responsible for work that continues after the popup closes.

The popup uses the existing per-source `initialImportCompletedAt` state to
decide whether the first-time action should remain visible. A completed source
does not need a new record or a special aggregate status. If the user retries
after a partial failure, the action simply invokes the same source imports
again; the existing source-level guards determine whether a source is already
running or can resume.

## Data flow

```text
popup: click Import all
  -> send import-all command
     -> background: find configured X, Reddit, GitHub sources
        -> invoke existing Import action for each source together
  -> popup continues reading existing per-source snapshots
     -> each row displays its own durable status
```

## Error handling

- A source-specific failure is reported through that source's existing row
  status and does not cancel the other source launches.
- If configuration is unavailable, the command performs no source imports and
  the popup keeps its existing configuration/connection guidance.
- If a source is disabled or not configured, it is not included.
- If the popup closes after launch, imports continue under the existing
  background lifecycle.
- The action remains available after a failed, paused, cancelled, or partial
  first import until the configured platform sources have completed their
  initial full import.

## Testing

- Message tests accept and preserve the new `import-all` command shape.
- Background tests verify that one command invokes the existing import path
  for each configured and enabled platform source.
- Background tests verify that Chrome bookmarks and unconfigured/disabled
  sources are excluded.
- Failure tests verify that one rejected source import does not prevent the
  other source imports from being started.
- Popup tests verify first-time visibility, hiding after initial completion,
  safe behavior while configuration/snapshot data is unavailable, and
  preservation of the individual Import buttons.
- Run focused extension tests, TypeScript checks, the production extension
  build, React Doctor where applicable, and `git diff --check`.

## Acceptance criteria

1. A first-time user can click one `Import all` button to start the existing
   full imports for configured X, Reddit, and GitHub sources together.
2. Chrome bookmark behavior remains a separate opt-in action.
3. Per-source durable progress and errors remain visible and authoritative.
4. No aggregate database record, new queue, or source-specific import rewrite
   is introduced.
5. Partial failures do not block other source launches, and the action remains
   available until the initial imports are complete.
6. Focused and full validation passes without overwriting unrelated working
   tree changes.
