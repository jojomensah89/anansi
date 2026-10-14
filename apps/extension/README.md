# Anansi Chrome extension

Public WXT/React MV3 builds contain no deployment URL or credential. Connect once through the popup to your own Anansi installation.

## Build and connect

Run `bun install --frozen-lockfile`, then `bun run --cwd apps/extension build`.
Open chrome://extensions, enable Developer mode, choose Load unpacked, and select apps/extension/.output/public/chrome-mv3.
Enter your Worker URL (or http://127.0.0.1:8787 locally) and extension access key in the popup. A distinct server INGEST_TOKEN is recommended; otherwise use ANANSI_SECRET. Grant that exact server origin when prompted. Sign into providers in the same browser profile before importing. Chrome bookmark mirroring is optional.

Disconnect pauses delivery and retains pending captures. Reconnect to the same library to recover them. Switching servers is blocked while pending work belongs to another library. Clearing browser storage loses queued captures.

## Package and verify

Run `bun run --cwd apps/extension compile`, `bun run --cwd apps/extension zip`, and `bun run --cwd apps/extension check:public-artifact`.
See release/chrome/README.md and PRIVACY.md at the repository root. Build success is not signed-in capture acceptance. Firefox launch verification is deferred.

## Private configured builds

Set ANANSI_EXTENSION_ORIGIN and ANANSI_EXTENSION_INGEST_TOKEN, then run `build:private` or `zip:private` in apps/extension. These scripts explicitly select private mode; ordinary builds ignore configured values and remain public.
Anyone with a private artifact can extract its credential. Never share it, commit it or upload it to a store. Rotate the key and rebuild if exposed.
