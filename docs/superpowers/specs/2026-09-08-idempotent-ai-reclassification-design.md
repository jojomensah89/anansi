# Idempotent AI Topic Reclassification

**Status:** Approved design; implementation pending

## Problem

The Settings page exposes `Reclassify AI topics`. The current endpoint clears
AI assignments and resets existing tagging jobs, then nudges the local worker.
It does not make the operation idempotent while a reclassification pass is
already queued. The worker's bounded reconciliation can therefore create the
next chunk of missing current-generation tagging jobs on each repeated click.
In the observed local run, the pending count grew by 16 per click.

The same control also reports the short HTTP request as complete even though
the durable tagging work continues in the background. The UI can therefore be
clicked again while the first pass is still active.

## Goals

1. Make repeated reclassification requests safe and idempotent while current
   tagging work is queued, running, retrying, or being reconciled.
2. Keep one durable tagging job per current model/content generation and retain
   the existing bounded, resumable worker behavior.
3. Keep manual tags and suppression overrides unchanged.
4. Make the Settings control reflect durable queue progress, not only the POST
   request lifecycle.
5. Preserve hosted and local AI provider behavior outside this reclassification
   guard.

## Non-goals

- Changing the tagging prompt, model, retry policy, or batch size.
- Adding a new AI queue or replacing the existing `ai_enrichment_jobs` table.
- Making reclassification synchronous with provider inference.
- Deleting failed jobs or existing canonical topic definitions.

## Design

### Server idempotency

The reclassification route will inspect current-model tagging progress before
starting a new pass. If current-generation jobs are already pending, retrying,
or running, the route returns the current taxonomy version and progress without
clearing assignments or resetting jobs. This makes repeated requests from the
same tab, another tab, or a direct client harmless.

If no current-generation tagging work is active, the route performs the existing
reclassification operation: remove AI-provenance assignments, prune orphaned
legacy AI custom labels, reset existing tagging jobs to pending, and nudge the
local worker when one is configured. Existing reconciliation remains bounded;
missing current-generation rows are still filled by the worker's normal
resumable passes, and primary-key job identities prevent duplicates.

The response shape remains compatible: `{ taxonomyVersion, progress }`. The
progress query must be scoped to the active tagging model so old model
generations do not block or inflate the current pass.

### Settings progress state

After a successful reclassification request that reports queued work, the
Settings page keeps the action disabled and displays its existing
`Reclassifying...` state while refreshing `/api/ai` at a bounded interval.
Polling stops and the control becomes available when no current-generation
tagging work remains pending, retrying, or running. Terminal failures do not
leave the control permanently disabled; the existing failed count remains
visible so the user can see that provider recovery is needed.

The component must stop its timer on unmount and avoid applying responses from
an obsolete polling cycle. A normal initial Settings load remains unchanged.

### Data flow

```text
click
  -> POST /api/ai/reclassify
     -> inspect active tagging progress
        -> active work: return progress; no reset
        -> idle: clear AI assignments, reset jobs, nudge worker
  -> update Settings progress
  -> while queued work exists: GET /api/ai
  -> stop polling when queued work reaches a terminal state
```

## Error handling

- If the POST fails, clear the local reclassifying state and show the existing
  error message.
- If a progress refresh fails, stop that polling cycle, retain the disabled
  state only for the current request window, and show the existing error
  message rather than inventing a queue value.
- Provider failures remain governed by the existing retry/backoff lifecycle;
  this change does not classify or suppress provider errors.
- A request arriving during active work is successful and returns authoritative
  progress; it is not treated as a conflict or a new reclassification.

## Testing

- Database/API regression: a second reclassification request while current
  tagging jobs are pending does not delete AI assignments again, reset attempts,
  or add job rows.
- Database/API regression: an idle reclassification still clears AI
  assignments, preserves manual assignments and overrides, and reopens the
  current tagging jobs.
- Model-generation regression: old-model jobs do not block an active current
  generation or appear in current progress.
- Settings component regression: the button is disabled while queued work is
  reported, refreshes progress, stops polling at a terminal state, and cleans
  up its timer on unmount.
- Run focused database/API/UI tests, full `bun test`, type checks, web build,
  React Doctor, and `git diff --check`.

## Acceptance criteria

1. With tagging work pending, repeated clicks or duplicate POSTs leave the
   current job-row count and pending count unchanged.
2. An idle reclassification starts exactly one current-generation pass and
   preserves all manual tags and suppression behavior.
3. The Settings button remains unavailable while the pass is active and
   becomes available after pending/running/retrying work reaches zero or the
   pass reaches terminal failures.
4. No new schema, provider, prompt, retry, or hosted scheduling behavior is
   introduced.
5. Focused and full validation passes, with unrelated dirty worktree files
   preserved.
