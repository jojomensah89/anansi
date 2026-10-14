# Anansi self-hosted Chrome launch

Date: 2026-10-14
Status: Proposed design; user approved workstream scope, implementation review pending.

## Product scope

Each user deploys a single-user Anansi library into their own Cloudflare account,
installs the same public Chrome extension, connects once, and captures supported
saves. This release covers deployment/security, Chrome extension readiness, and
Chrome Web Store preparation. Firefox, a docs website, shared hosting, new capture
platforms, and unrelated visual redesigns are deferred.

Existing untracked `.stitch/` and `design/support.js` are unrelated and must be
preserved. Required setup corrections, privacy disclosures, release notes and
reviewer instructions are release artifacts, not a new docs-site workstream.

## Approaches and decision

1. Recommended: credential-free public package, existing URL/key connection form,
   and optional separate extension credential. This fits the current self-hosted
   architecture and avoids a new account or pairing service.
2. Browser-mediated pairing with per-device credential issuance and revocation.
   This reduces key copying but adds server-side device state and more recovery
   paths; defer until the simpler launch is accepted.
3. Private configured builds only. Retain as an opt-in development/self-host path,
   but this does not meet the public Chrome store installation requirement.

## 1. Deployment and security

Keep Worker, D1, R2, optional AI/Vectorize features and the existing scheduled
recovery architecture. Verify the canonical Wrangler build/deploy and SQL
migration flow against a fresh Cloudflare deployment. A deploy button alone is
not acceptance evidence. Avoid automatic migration-ledger repair or destructive
database operations.

Keep `ANANSI_SECRET` as the simple setup and compatibility path. If an explicit
`INGEST_TOKEN` is configured, use it for extension endpoints before falling back
to the master secret; apply the same explicit-override rule to existing
`LIBRARY_TOKEN` and `MCP_TOKEN`. Document and test this precedence so operators
can limit an extension key's authority. A configured ingest-only key must fail
library and MCP authorization when distinct library/MCP credentials apply.
Missing credentials must continue to fail closed. Rotation invalidates the old
credential; no key or secret is placed in a URL, browser history or release log.

Review public login/ingest/MCP abuse protection. Choose actual Cloudflare binding
or deployment-level controls supported by the verified account and runtime;
an in-memory counter cannot be described as global rate limiting. Legitimate
capture backlogs must remain resumable after throttling.

Retain existing cookie origin checks, HTTPS cookie flags, bounded request bodies,
media MIME/signature checks, destination/redirect restrictions and queue limits.
Exercise hostile capture messages and media destinations with focused tests.
Review production response headers for compatibility with SSR and extension
connection; add only controls whose behavior is verified.

Audit dependencies and minimize CI permissions. Validate both the Cloudflare
Worker build and the credential-free Chrome artifact in CI. Inspect generated
artifacts for credentials and unintended permissions. Live GitHub settings and
dependency alerts need separate verification from committed workflow files.

## 2. Chrome extension

Public build/zip commands must not require or embed a Worker origin or token.
Loading the repository root `.env` must not silently convert a public package
into an owner-configured package. Private configured artifacts require an
explicit mode and are excluded from store release output. Public release checks
must reject embedded connection credentials rather than print their values.

An unconfigured extension stays inactive until connected. Preserve the existing
popup layout while fixing connection state and copy where necessary. Ask for
the exact user-selected server origin through optional host permission. A denied
or failed permission request must stop connection. Validate HTTPS or allowed
loopback HTTP, reject credential-bearing URLs, and validate server configuration
before persisting credentials. Display useful errors for denial, invalid key,
offline server, incompatible configuration and timeout. Secrets remain masked.

Restrict credential storage access to trusted extension contexts where Chrome
supports it. Verify page scripts/content scripts cannot retrieve connection
credentials. Reconnection and MV3 service-worker restarts must use the persisted
validated connection and refresh configuration safely.

Pending captures must not silently move to a different library when the server
URL changes. Inspect the current queue ownership model and enforce destination
ownership or block a switch until the user explicitly resolves pending work.
Disconnect pauses delivery, clears the connection and related credentials/caches,
and releases obsolete server permissions. Retaining or discarding queued captures
must be explained and tested; no silent data loss or fallback to embedded keys.

Keep optional Chrome bookmark permission opt-in and revoke it when mirroring is
disabled. Do not add new sources or broader mandatory host access. Preserve full
content hydration, ordered save/unsave delivery and durable retries.

## 3. Chrome release preparation

Produce a versioned Chrome ZIP from a credential-free build, record the commit
and artifact checksum, inspect the generated manifest and bundle, and keep the
private build path separate. CI must validate the same public build mode.

Prepare accurate store copy, icons/screenshots, permission explanations, support
contact, privacy/data-flow disclosures and reviewer instructions. Disclose saved
page text, private repository captures, local extension state, user-controlled
hosting, and optional Cloudflare AI processing. Do not claim no data transmission
simply because a user owns the destination. Store-required privacy material still
needs a publicly accessible URL; hosting a full docs site is deferred.

Supported-source claims require final-build acceptance. Incomplete sources remain
explicitly experimental or are excluded from supported claims. Submission and
public publication remain separate user-controlled release decisions.

## Acceptance and evidence

The user additionally requires all existing features to work. Launch acceptance
therefore covers the complete currently reachable product, not only the changed
connection and deployment code. Inventory from current routes, API handlers,
extension actions and MCP catalog; do not use historical plans as feature truth.

Maintain a feature matrix with source entry point, expected behavior, automated
coverage, local/browser evidence, Cloudflare/provider evidence, defects and final
status. Use explicit statuses: passed at the stated evidence level, failed,
blocked awaiting external access, or intentionally excluded from public claims.
No feature is marked passed solely because a build succeeds. Fix regressions
within this launch scope; material new product behavior still requires user
review. Optional features are exercised both disabled and enabled.

Required feature groups include:

- Library sign-in/sign-out and expired/rotated credentials; empty, loading,
  offline and error states; navigation and theme behavior.
- Grid, row and timeline views; pagination; keyword search and command palette;
  source, author, type, tag, media, archive, favorite, removed and NSFW filters;
  deep-link/search state and refresh after capture.
- Item details, text/highlights/media, notes, favorites, archive/unarchive,
  manual tags, bulk actions, saved-view collection create/apply/delete, and
  creator browsing and author-based navigation.
- Source configuration and health; enable/disable behavior; imports, resume,
  daily catch-up, native save/unsave, duplicate prevention and provider sign-in
  diagnostics for every current source; hide-removed preference persistence.
- Chrome page/selection/context-menu capture and optional bookmark mirroring;
  connect, reconnect, disconnect, service-worker restart, queue status/retry and
  outage recovery without cross-library delivery or data loss; per-source
  import/pause, initial/remaining Import all, Retry all, Open library and Details.
- Logical export and empty-library restore, interrupted restore recovery and
  rejection of invalid files; media serving, fetching, failure and retry.
- Optional automatic tagging/reclassification and semantic indexing/search,
  preview/confirmation, progress, pause/disable, vector cleanup, budgets and
  keyword fallback; scheduled execution against actual hosted bindings.
- MCP setup and authenticated HTTP transport: `search_saved`, `get_saved`,
  `get_saved_many`, `list_saved`, `list_recent_saves`, `list_author_saves`,
  `list_tags`, `library_stats`; filters, cursors, bounds and access denial.

Current source catalog declares X, Reddit, GitHub, TikTok and Web supported.
Those declarations require runtime acceptance before public release claims.
Current AI API exposes Cloudflare or unavailable runtime; historical local
Ollama UI branches are not active features and do not expand this launch scope.

Initial local baseline on 2026-10-14: `bun test` passed 696 tests across 76 files
with zero failures; `bun run typecheck` exited successfully. Runtime was Bun
1.4.2. This baseline is not final-build browser, provider or Cloudflare evidence.

Record commit, build mode, browser version, deployment identity, checks and known
limitations. Separate automated/local evidence from authenticated browser and
live Cloudflare evidence.

- Focused tests for public/private build selection, token precedence, origin
  validation, permissions, connection/disconnect, queue destination ownership,
  hostile messages, and authentication failures.
- Root tests/typecheck, extension compile, Chrome build/ZIP, Cloudflare Worker
  build, and `git diff --check`; report baseline failures separately.
- Fresh Chrome profile: install, permission prompts, connect, restart/reconnect,
  toolbar and context-menu capture, optional bookmarks, wrong key and denial.
- Signed-in final-build X, Reddit, GitHub and TikTok checks: save, unsave, rapid
  toggles, full-content hydration, eventual library visibility, outage recovery
  and restart; do not use historic acceptance to close current gates.
- Fresh Cloudflare deploy: resources, migrations, login, extension capture,
  keyword search, authenticated MCP, scheduled recovery, export/restore. Verify
  optional AI only when enabled; record resource/quota failures honestly.
- Live wrong-token, unauthenticated and cross-origin checks; media egress checks;
  production cookie/header checks; artifact secret inspection.
- Upgrade/backup drill covers D1 and R2 as well as logical JSON export. Current
  JSON export excludes media bytes and must not be described as a full backup.

Cloudflare account access, provider sessions, Chrome developer account and public
privacy URL may require user participation. Finish independent code/artifact work
first, then request only the specific missing access or release decision. Never
ask the user to paste secrets into chat.

## Work packets

1. Public/private Chrome build separation and artifact checks.
2. Server credential precedence and targeted security/CI hardening.
3. Connection lifecycle, queue ownership and scoped popup usability fixes.
4. Clean deployment and final-build Chrome acceptance.
5. Chrome submission materials and versioned release candidate.

Assign one writer per file set. Use Luna XHigh for bounded non-UI implementation,
Luna Medium for popup work, and a fresh Sol High reviewer for verification and
final synthesis. Workers do not spawn further agents. Coordinate integration of
shared files explicitly. Material product and release decisions stay with the
user.
