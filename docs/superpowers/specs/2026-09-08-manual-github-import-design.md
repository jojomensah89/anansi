# Manual GitHub Import Design

> Historical plan/evidence: current product guidance is in [README](../../../README.md) and the 2026-11-05 overhaul decisions. Earlier local-first, hidden-TikTok, read-only/keyword-only MCP and daily-sync claims are superseded. This document does not establish signed-in or hosted acceptance.


## Goal

GitHub imports must begin only after the user clicks the GitHub row's Import button in the extension popup. Loading, installing, or restarting the extension must not fetch or enqueue GitHub stars automatically.

## Scope

- Remove the automatic initial GitHub import trigger from extension initialization, browser startup, and extension installation.
- Keep the popup's existing manual import command and its full-import behavior unchanged.
- Keep durable outbox recovery, source-run recovery alarms, heartbeat, tab mirroring, and scheduled page-source capture unchanged.
- Leave the existing `initialImportCompletedAt` persistence fields and lifecycle behavior intact for compatibility with existing state.

## Behavior

The background worker may initialize its listeners, recover queued work, schedule alarms, and start mirroring, but it must not call the GitHub import path as a side effect of initialization or lifecycle events. The manual popup command remains the only entry point for a GitHub full import. Existing in-progress runs and recovery alarms continue to be handled by their current paths.

## Verification

- Add or update focused extension tests so the manual command still starts a GitHub full import.
- Verify the background module no longer invokes the initial GitHub import helper from initialization, `onStartup`, or `onInstalled`.
- Run extension tests, TypeScript compilation, and the production extension build.
- Preserve unrelated working-tree changes.
