# Chrome release candidate

This directory prepares the self-hosted Chrome release. It does not submit,
publish, or declare the extension accepted by the Chrome Web Store.

## Package

From the repository root, install the lockfile and run:

```powershell
bun install --frozen-lockfile
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension zip
bun run --cwd apps/extension check:public-artifact
bun run build
bun run apps/web/scripts/launch-feature-smoke.ts
git diff --check
```

The public package must contain no deployment origin or credential, including
when the local environment contains private-build values. Only the explicit
private build mode may embed these. Never submit a private configured package.
Record the final commit, extension version, ZIP filename, SHA-256, manifest and
verification results with the candidate. Hash the ZIP after all changes finish.

## Proposed listing

Name: Anansi

Summary: Save bookmarks, stars and web pages to your own searchable Anansi library.

Description: Anansi connects Chrome to a personal library hosted in your own
Cloudflare account. Capture supported bookmarks and saved posts, GitHub stars,
web pages and selections, and optionally mirror Chrome bookmarks. Search and
organize the library in the web app, or connect a compatible MCP client. You
must deploy an Anansi server and connect the extension to its URL and access key.
Provider imports require signing in to the corresponding site in this browser.
Enable automatic tags and semantic search only if you want to use Cloudflare AI.

Before submission, reconcile supported-source claims with the final signed-in
acceptance matrix. Do not promise instant, unlimited or universal capture.

## Permissions and privacy

- Storage: connection state, queued captures, import progress and recovery.
- Alarms: retry scheduling, heartbeat and incremental catch-up.
- Tabs: provider import tab lifecycle and opening the user's library.
- activeTab and scripting: capture the page or selection after a user gesture.
- Context menus: explicit Save page and Save selection commands.
- Supported provider hosts: observe save events and import signed-in content.
- Optional server host: contact only the deployment origin the user selects.
- Optional bookmarks: mirror Chrome bookmarks only after enabling the feature.

Data disclosures must reflect saved text, website content, URLs, author metadata,
authentication information stored locally, and user-controlled server delivery.
Self-hosting does not mean no data transmission. Publish PRIVACY.md at an
accessible HTTPS URL before submission. No full docs site is required for that.

## Reviewer instructions

Provide a dedicated isolated reviewer deployment and synthetic test content.
Supply reviewer credentials privately through the developer dashboard, never in
the ZIP, public listing, screenshots or repository. Provide both server URL and
extension access key. If split keys are enabled, provide a separate library key.

1. Install the public package and open the popup; it starts disconnected.
2. Connect to the reviewer URL/key and grant that exact optional host permission.
3. Save an ordinary test page and a selection, open the library and verify content.
4. Verify optional bookmarks stays disabled until explicitly enabled.
5. Exercise supported imports with approved test accounts; don't provide personal
   provider credentials in this document.
6. Check restart recovery, disconnect/reconnect, offline errors and invalid keys.

Collect actual Chrome screenshots: disconnected onboarding, connected source
status, page capture and populated synthetic library. Use store-required image
dimensions verified against the developer dashboard at submission time. Browser
installation/permission steps and final publication remain user-controlled.

## Deployment and operations gates

Fresh-account acceptance must exercise provisioning, required secrets,
Vectorize 384/cosine setup, all D1 migrations, first capture, search, MCP,
scheduled recovery, export/restore and optional AI when enabled. Current logical
JSON export excludes R2 bytes. Before upgrades, back up D1 and R2 separately and
record the Worker version. A Worker rollback does not undo SQL migrations; use
an isolated restore drill and a schema-compatible Worker for recovery.

Worker rate-limit bindings protect login (20/minute), extension traffic
(600/minute) and MCP (120/minute) per client IP and Worker host. These are
Cloudflare-location counters, eventually consistent, not global quotas. Shared
client IPs share a budget. Namespace IDs must not collide with unrelated
same-account bindings. Ingest 429/503 responses retain resumable queue work.
Validate the bindings in the final hosted deployment before release.
