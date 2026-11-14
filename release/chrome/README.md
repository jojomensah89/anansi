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

## Listing and disclosures

Use [LISTING.md](LISTING.md) for the draft listing, every permission/host justification and data disclosures. Run [the side-by-side checklist](../side-by-side-test.md) before making source acceptance claims.

## Reviewer instructions

Provide a dedicated isolated reviewer deployment and synthetic test content.
Supply reviewer credentials privately through the developer dashboard, never in
the ZIP, public listing, screenshots or repository. Provide the reviewer server URL and owner sign-in privately; pair through Connect extension with a single-use code and capture-only key.

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
