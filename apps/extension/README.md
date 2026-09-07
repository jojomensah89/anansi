# Anansi browser extension

This is the private WXT/React MV3 extension that captures bookmarks and saved
items from the browser session you already have. It does not read cookies and
does not provide a server or token field in the popup.

## Build locally

From the repository root:

```powershell
bun install
Copy-Item .env.example .env
# Set ANANSI_EXTENSION_ORIGIN to the public local/deployed origin and set
# ANANSI_EXTENSION_INGEST_TOKEN to the same value as the server INGEST_TOKEN.
bun run --cwd apps/extension build
```

Load `apps/extension/.output/chrome-mv3` from `chrome://extensions` with
Developer mode enabled. For local development the origin is
`http://127.0.0.1:3001`; the launcher keeps the Bun API port internal.

The configured bundle contains the ingest credential and is therefore a
private artifact. Do not upload it to a store or commit it. A public release
should ship source and reproducible build instructions, not a configured
personal bundle.

## Test and development

```powershell
bun test
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
```

The extension's import and delivery tests use scrubbed synthetic captures. A
real X, Reddit, or GitHub import still requires the corresponding provider to
be signed in within the same browser profile.
