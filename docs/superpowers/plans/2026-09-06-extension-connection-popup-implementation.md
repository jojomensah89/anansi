# Extension connection and popup UX implementation plan

**Date:** 2026-09-06

**Design:** `docs/superpowers/specs/2026-09-06-extension-connection-popup-design.md`

**Goal:** Build the private extension with an immutable Anansi origin and ingest credential, expose one public origin locally and on Cloudflare, simplify the popup, retain a daily catch-up, and document both setup paths accurately.

## Execution rules

- Preserve all pre-existing work. At plan creation, `.env.example`, `.gitignore`, `packages/infra/alchemy.run.ts`, `packages/infra/package.json`, and `packages/infra/.alchemy/log/out` are modified; three generated/placeholder files are staged for deletion; `outputs/` and `packages/infra/scripts/` are untracked. Inspect overlapping files before editing and stage only task-owned hunks.
- The existing infrastructure edits overlap `.env.example` and Cloudflare deployment wiring. Reconcile their current working-tree content; do not reset, replace, or commit unrelated changes.
- Add deterministic tests before implementation. Keep modules small enough to test without mounting the entire popup or starting a real browser.
- Keep `INGEST_TOKEN` authorization. Never print the token, include it in diagnostics, expose it to page-world scripts, or put it in the web application's client bundle.
- A configured extension artifact is private and non-distributable. Do not create a public-store build containing a shared owner token.
- Preserve the durable outbox, source-run records, retry policy, remote source kill switches, and immediate live delivery.
- Do not broaden this work into provider-parser changes. Improve `422` detail propagation, then record X authenticated acceptance as a separate runtime gate.
- Do not claim Cloudflare deployment, provider sign-in, or production behavior from local tests.
- Do not run `bun run check` as validation because it writes across the repository. Use focused Biome checks only if formatting is required.

## Phase 0: Baseline and overlap protection

### Task 0.1: Record the current state and focused baseline

**Inspect:**

- `git status --short`
- `git diff -- .env.example packages/infra/alchemy.run.ts packages/infra/package.json`
- `apps/extension/wxt.config.ts`
- `apps/extension/entrypoints/background.ts`
- `apps/extension/entrypoints/popup/App.tsx`
- `apps/extension/lib/config-cache.ts`
- `apps/extension/lib/ingest-transport.ts`
- `apps/web/vite.config.ts`
- `apps/web/src/lib/api.ts`
- `scripts/dev.ts`
- `README.md`

**Run:**

```powershell
bun test apps/extension/lib/config-cache.test.ts apps/extension/lib/ingest-transport.test.ts apps/extension/lib/popup-state.test.ts apps/extension/test/sync.integration.test.ts apps/web/src/server/api.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
```

Record pre-existing failures without fixing unrelated code.

**Exit condition:** Relevant baseline behavior and every overlapping dirty hunk are understood before edits.

## Phase 1: Immutable private-extension connection

### Task 1.1: Add a validated connection module

**Create:**

- `apps/extension/lib/connection.ts`
- `apps/extension/lib/connection.test.ts`

**Modify:**

- `apps/extension/lib/config-cache.ts`, only if origin validation should be reused rather than duplicated
- `apps/extension/wxt.config.ts`
- `apps/extension/env.d.ts` or the WXT-generated environment declaration seam, if necessary

**Test first:**

- HTTPS origins normalize to scheme, host, and effective port.
- Loopback HTTP is allowed; non-loopback HTTP, URL credentials, unsupported schemes, and malformed values are rejected.
- Missing origin fails with an explicit build/configuration error.
- Missing or blank ingest token fails with an explicit build/configuration error.
- Returned connection data is immutable and contains exactly `origin` and `token`.
- Error messages name missing variables but never include supplied token values.

**Implement:**

- Read `ANANSI_EXTENSION_ORIGIN` and `ANANSI_EXTENSION_INGEST_TOKEN` through WXT's build-time environment mechanism.
- Centralize validation and canonicalization in a side-effect-free function, then expose the validated build connection to extension entrypoints.
- Make production extension builds fail before artifact delivery when either variable is absent or invalid.
- Ensure only extension code receives these values. Verify the web Vite build has no reference to the token variable or token value.

**Verify:**

```powershell
bun test apps/extension/lib/connection.test.ts apps/extension/lib/config-cache.test.ts
bun run --cwd apps/extension compile
```

**Suggested commit:** `feat(extension): validate private build connection`

### Task 1.2: Replace browser-stored server and token settings

**Modify:**

- `apps/extension/entrypoints/background.ts`
- `apps/extension/lib/heartbeat.ts`, only at its existing connection-provider seam
- `apps/extension/test/sync.integration.test.ts`

**Test first:**

- Config, stats, ingest, and heartbeat use the same build origin and token.
- Legacy `server` and `token` values in `browser.storage.local` cannot override the build connection.
- Cached remote config is invalidated by a changed build origin/token between builds, without persisting either value as runtime settings.
- No runtime or page-world message includes the token.
- Queue recovery still works after a service-worker restart.

**Implement:**

- Replace the current `settings()` server/token lookup with the connection module.
- Retain storage only for operational state such as statuses, outbox/run state, bookmark mirroring, and installation identity.
- Remove writes and reads for the legacy connection keys. Do not delete unrelated user state.
- Adapt injected transports rather than duplicating authorization construction.

**Verify:**

```powershell
bun test apps/extension/test/sync.integration.test.ts apps/extension/lib/heartbeat.test.ts apps/extension/lib/capture-queue.test.ts
bun run --cwd apps/extension compile
```

**Suggested commit:** `refactor(extension): use immutable build connection`

## Phase 2: One public local origin

### Task 2.1: Proxy API and MCP through Vite

**Modify:**

- `apps/web/vite.config.ts`
- `apps/web/src/lib/api.ts`
- `scripts/dev.ts`

**Create or extend tests:**

- A focused Vite configuration test or exported pure proxy-config test under `apps/web/`
- A local-launcher/proxy smoke script only if configuration inspection cannot prove header and route behavior

**Test first:**

- `/api/*` targets the internal Bun origin without rewriting the path.
- `/mcp` and any `/mcp/*` continuation target the same internal origin.
- Method, request body, `Authorization`, cookies, response status, and response headers are preserved by the proxy configuration.
- The browser API client defaults to same-origin paths without `VITE_API_BASE`.
- The launcher advertises `http://127.0.0.1:3001` as the extension/library origin and labels `8788` internal.

**Implement:**

- Add narrow Vite proxy rules for `/api` and `/mcp` to `http://127.0.0.1:8788`.
- Stop passing `VITE_API_BASE` from `scripts/dev.ts` and keep the web client same-origin.
- Keep both internal processes and the existing occupied-port preflight.
- Do not log the ingest credential. Replace the current paste-ready token output with build instructions that reference environment configuration without echoing the value.
- Keep exact-origin local server protections for direct access as defence in depth.

**Verify:**

```powershell
bun run dev:local
# In a second terminal, perform bounded probes through port 3001:
curl.exe -i http://127.0.0.1:3001/api/auth/session
curl.exe -i http://127.0.0.1:3001/api/extension/config
curl.exe -i http://127.0.0.1:3001/mcp
```

The unauthenticated extension-config request should be rejected through the proxy, proving route and status preservation. Do not expose a real bearer token in command output.

**Suggested commit:** `fix(dev): expose one public Anansi origin`

## Phase 3: Popup connection truth and source visibility

### Task 3.1: Extract connection/source-row presentation

**Create:**

- `apps/extension/lib/popup-connection.ts`
- `apps/extension/lib/popup-connection.test.ts`

**Modify:**

- `apps/extension/lib/popup-state.ts`, only if existing state primitives naturally belong there

**Test first:**

- All four provider rows exist while config is loading.
- All four rows remain visible for timeout, unreachable, `401`, `403`, `404`, and malformed-config failures.
- Before usable config, actions requiring remote instructions are disabled and copy is neutral/actionable.
- A server-disabled source remains visible and says it is off.
- Connected config augments the static catalogue without duplicating or losing rows.
- Connection labels distinguish unreachable, credential mismatch, incompatible server, and connected.
- Diagnostics redact bearer values, authorization headers, and credential-shaped query/body content.

**Implement:**

- Treat X, Reddit, TikTok, and GitHub as the static extension product catalogue.
- Represent config loading and failure explicitly instead of collapsing them into `null`.
- Merge remote operational fields and kill-switch state onto static rows.
- Define a small discriminated connection-state type consumed by the popup.

**Verify:**

```powershell
bun test apps/extension/lib/popup-connection.test.ts apps/extension/lib/popup-state.test.ts
```

**Suggested commit:** `fix(extension): keep popup sources visible`

### Task 3.2: Simplify the popup and fix Open library

**Modify:**

- `apps/extension/entrypoints/popup/App.tsx`
- `apps/extension/entrypoints/popup/App.css`, only if removal exposes layout issues

**Test through extracted helpers and focused rendering where supported:**

- Settings gear, server field, token field, interval controls, and Save button are absent.
- **Open library** resolves `/` against the build origin.
- The popup renders source rows during each connection state.
- Credential mismatch copy tells the owner to rebuild with matching configuration.
- Current-page capture, Chrome bookmark mirroring, retry actions, and diagnostics remain functional.
- The popup remains keyboard-accessible and scrollable at its current narrow width.

**Implement:**

- Remove connection/schedule state and storage effects from the React component.
- Fetch config/stats with the shared build connection.
- Render explicit connection truth and static-source fallbacks.
- Open the canonical origin root rather than a mutable server field.
- Preserve existing redaction and operational controls.

**Verify:**

```powershell
bun test apps/extension/lib/popup-connection.test.ts apps/extension/lib/popup-state.test.ts
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

Run React Doctor after the React change and fix only findings introduced by this patch.

**Suggested commit:** `feat(extension): simplify connected popup`

## Phase 4: Fixed daily catch-up

### Task 4.1: Replace configurable intervals with one policy

**Create or extend:**

- A focused scheduling helper/test under `apps/extension/lib/`
- `apps/extension/test/sync.integration.test.ts`

**Modify:**

- `apps/extension/entrypoints/background.ts`

**Test first:**

- Startup/install schedules `anansi-sync` every 1,440 minutes.
- Legacy `syncEvery` storage values do not alter the schedule.
- The alarm starts only config-enabled sources with history-import mode.
- TikTok observation is not converted into background import.
- Manual import, pause/resume, source-run recovery, heartbeat, and outbox alarms retain their behavior.
- A remote kill switch prevents the next scheduled import.

**Implement:**

- Replace `syncEvery` lookup with a named daily interval constant.
- Schedule the catch-up unconditionally for a valid build connection.
- Retain the existing incremental/resumable source-run semantics.
- Leave stale `syncEvery` storage harmless; optional cleanup may remove that key without touching other state.

**Verify:**

```powershell
bun test apps/extension/test/sync.integration.test.ts apps/extension/lib/source-runs.test.ts apps/extension/lib/session-import.test.ts
bun run --cwd apps/extension compile
```

**Suggested commit:** `refactor(extension): use daily catch-up policy`

## Phase 5: Actionable ingest rejection details

### Task 5.1: Parse bounded safe server errors

**Modify:**

- `apps/extension/lib/ingest-transport.ts`
- `apps/extension/lib/ingest-transport.test.ts`
- `apps/extension/lib/capture-queue.test.ts`, if transport detail changes the recorded failure contract

**Test first:**

- A JSON `422` with a short `error`, `message`, or safe error code produces an actionable diagnostic.
- Oversized strings are truncated at a documented bound.
- HTML, binary, invalid JSON, nested objects, arrays, and credential-shaped detail fall back to status-only text.
- `Authorization`, bearer strings, cookies, token-like fields, and request bodies never appear in returned errors.
- Existing permanent/retryable HTTP classification is unchanged.
- Reading error detail cannot consume an otherwise-needed successful receipt body.

**Implement:**

- Extract only allowlisted scalar JSON fields from non-success responses.
- Apply existing redaction plus a strict character/length bound.
- Attach the safe reason to the durable failure diagnostic while retaining status code and classification.

**Verify:**

```powershell
bun test apps/extension/lib/ingest-transport.test.ts apps/extension/lib/capture-queue.test.ts apps/extension/test/sync.integration.test.ts
```

**Suggested commit:** `fix(extension): explain rejected captures safely`

## Phase 6: Deployment and setup documentation

### Task 6.1: Wire and document extension build inputs

**Modify carefully:**

- `.env.example`
- `.gitignore`
- `apps/extension/package.json`, only if a wrapper script improves deterministic validation
- `packages/infra/alchemy.run.ts` or `packages/infra/scripts/*`, only where existing deployment output can safely surface the deployed origin
- `README.md`

**Requirements:**

- `.env.example` documents all three independent server secrets and both extension build variables without real values.
- The example makes `ANANSI_EXTENSION_INGEST_TOKEN` equal in value to `INGEST_TOKEN` conceptually, not through unsupported dotenv interpolation.
- Secret-bearing local build files and configured extension artifacts are ignored where necessary.
- The local guide uses only `http://127.0.0.1:3001`; `8788` is documented as internal diagnostics.
- The Cloudflare guide separates provider authentication, server secrets, deploy, resulting origin, private extension build, load-unpacked, and acceptance.
- The README warns that configured builds contain an extractable owner credential and must not be uploaded to a public store or shared.
- Hosted instructions remain explicitly unverified until a clean-account deployment passes.
- MCP documentation uses `<origin>/mcp`; API documentation uses `<origin>/api/*`.
- Remove every instruction that tells the user to paste connection settings into the popup.

**Review:**

- Search README, comments, CLI output, and example env files for obsolete `8788` public-origin or popup-paste instructions.
- Search tracked and generated diffs for real token values.
- Reconcile existing infrastructure changes hunk by hunk and commit only changes that belong to this plan.

**Verify:**

```powershell
rg -n "paste.*token|popup.*token|127\.0\.0\.1:8788|VITE_API_BASE|sync automatically|syncEvery" README.md .env.example scripts apps packages -g '!node_modules' -g '!dist' -g '!.output'
git diff --check
```

Expected remaining `8788` references must be explicitly internal server targets, tests, or low-level developer diagnostics.

**Suggested commit:** `docs: clarify private extension setup`

## Phase 7: Integrated validation and acceptance

### Task 7.1: Full automated validation

**Run:**

```powershell
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
git diff --check
```

Run React Doctor for the popup change. Inspect the generated manifest and bundle to confirm:

- no new `cookies` or `<all_urls>` permission;
- the token is present only where required inside the private extension bundle;
- the token is absent from the web build, README, logs, and source-control diff;
- legacy mutable popup settings are absent.

Report unrelated or pre-existing failures separately.

### Task 7.2: Local browser acceptance

1. Start `bun run dev:local` with matching server and extension build configuration.
2. Confirm `/`, `/api/auth/session`, `/api/extension/config`, and `/mcp` route through `http://127.0.0.1:3001` with their appropriate authentication behavior.
3. Build and load a fresh extension artifact without entering settings.
4. Confirm all provider rows render and **Open library** opens the UI.
5. Intentionally build once with a mismatched token; confirm a clear credential error with no secret disclosure.
6. Restore matching configuration and verify config, stats, heartbeat, current-page capture, queue receipt, and library display.
7. Confirm Chrome bookmark mirroring still requests permission only when enabled.
8. Trigger or simulate daily alarm handling and verify only eligible enabled sources start.
9. Reproduce X ingestion and confirm a `422` now shows a safe server reason. Diagnose the provider payload separately; do not call it fixed without signed-in acceptance.
10. Check the popup at its normal width and shortest practical viewport for scrolling, focus visibility, and readable error copy.

### Task 7.3: Cloudflare release gate

This is not required to prove local implementation, but it is required before removing the README's unverified warning:

1. Deploy from a clean-account-equivalent configuration.
2. Read back Worker URL, migrations, D1, R2, and secret bindings without displaying secret values.
3. Build a fresh private extension against the Worker origin.
4. Verify library sign-in, extension config/stats/heartbeat, one page capture, one authenticated provider import, search, MCP authentication, export, and restore.
5. Record exact environment, timestamp, and failures. Keep the hosted warning if any gate remains incomplete.

## Completion report

Report separately:

- files and behavior changed;
- focused and full test/build/typecheck/diff-check results;
- React Doctor and generated-artifact inspection;
- local browser acceptance evidence;
- X, TikTok, and other authenticated-provider evidence or remaining gaps;
- Cloudflare deployment evidence or the continuing unverified status;
- preserved pre-existing working-tree changes.

## Final acceptance checklist

- [ ] A valid private build connects with no popup configuration.
- [ ] The ingest endpoint still rejects missing or wrong credentials.
- [ ] The browser, extension, and human use one public origin in each environment.
- [ ] Local `/api/*` and `/mcp` proxy behavior preserves authentication and errors.
- [ ] **Open library** opens the web UI.
- [ ] X, Reddit, TikTok, and GitHub remain visible during loading and failures.
- [ ] Credential mismatch, unreachable server, and incompatible server are distinguishable.
- [ ] The popup has no server, token, interval, or Save controls.
- [ ] Catch-up runs daily; immediate delivery and manual operations remain intact.
- [ ] Safe `422` detail is actionable without leaking request or credential data.
- [ ] Queue durability, resume state, remote kill switches, and secret redaction still pass.
- [ ] README local steps match verified behavior.
- [ ] Hosted steps remain labelled unverified until the Cloudflare gate passes.
- [ ] No unrelated working-tree changes are overwritten or committed.
