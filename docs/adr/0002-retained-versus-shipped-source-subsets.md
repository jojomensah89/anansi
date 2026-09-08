# ADR 0002: Retained versus shipped source subsets

- Status: Accepted
- Date: 2026-09-07
- Baseline: `25aed8d`
- Implemented by: `31975d7` (`refactor(sources): define capability views`)

## Decision

Treat source support as independent views, not one `supported` boolean. The
canonical rows live in `SOURCE_CAPABILITIES` and the typed/narrow views are
exported from `packages/sources/src/capabilities.ts`:

- **Retained parser/storage identities:** `RETAINED_PARSING_SOURCES` is
  `x`, `reddit`, `web`, `github`, and `tiktok`. Existing TikTok payloads and
  rows remain parseable and repairable.
- **Current shipped product sources:** `VISIBLE_LIBRARY_SOURCES` is `x`,
  `reddit`, `web`, and `github`.
- **Extension platform paths:** `EXTENSION_PLATFORM_SOURCES` is `x`, `reddit`,
  and `github`; `SHIPPED_CAPTURE_SOURCES` adds manual `web` capture.
- **Import mechanisms:** `PAGE_IMPORT_SOURCES` is `x`; `SESSION_IMPORT_SOURCES`
  is `reddit` and `github`. They remain distinct adapters even though they
  share lifecycle rules.
- **TikTok:** `retainedParsing` remains true, but `captureMethods` is empty,
  `productVisible` and `extensionPlatform` are false, and it is hidden from
  current UI, search, detail, stats, MCP, and shipped extension configuration.

The capability module remains dependency-light: it imports no browser,
database, parser, or server runtime. Display copy and endpoint details remain
owned by their consumers, while `extension-config.ts` validates the shared wire
contract without importing runtime adapters.

## Context

Before this packet, the repository had multiple truthful sets with repeated
membership decisions. They differed because retention, visibility, capture
method, health, and product exposure are different questions. The packet now
centralizes identity/facts while preserving consumer-specific views and
presentation metadata.

## Consequences

- Adding a parser does not automatically ship a source in the UI or MCP.
- Hiding a source requires database visibility enforcement as well as omission
  from product views; UI omission alone is not a security or data boundary.
- Tests assert retained TikTok parsing/storage, current visible sets, manual Web
  capture, distinct session/page import paths, and capability-fact invariants.
- Product re-enablement of TikTok or a new import mechanism needs an explicit
  capability and acceptance review.

## Rollback

This is a stateless code and contract refactor: `31975d7` adds no database
migration and does not rewrite stored item rows. Reverting the capability,
catalogue, visibility, and config-consumer code is sufficient to restore the
previous implementation. The valid `ExtensionRemoteConfig` JSON shape remains
compatible, but the new shared validator is intentionally stricter: unknown
sources, duplicate rows, extra keys, malformed URLs, and inconsistent source
facts are rejected. Roll back the config producer/consumer pair together (or
serve the old accepted shape) so an old extension is not paired with a new
strictness boundary. The `/api/sources` product response also changed Reddit
and GitHub `mode` from `page` to `session`; old web/API consumers typed the
field as `page | observe | manual`. Roll the server and web consumers together,
or make the consumer tolerate the new enum, before switching versions.
Retained TikTok rows and old capture payloads are not a rollback obstacle.

## Evidence and acceptance boundary

Established behavior is documented in [`README.md`](../../README.md),
[`packages/sources/src/item.ts`](../../packages/sources/src/item.ts),
[`packages/sources/src/capture.ts`](../../packages/sources/src/capture.ts),
[`apps/web/src/server/source-catalog.ts`](../../apps/web/src/server/source-catalog.ts),
[`packages/db/src/visibility.ts`](../../packages/db/src/visibility.ts), and
[`packages/mcp/src/tools.ts`](../../packages/mcp/src/tools.ts). The architectural
rationale and original work packet are in [`docs/architecture-improvement-guide.md`](../architecture-improvement-guide.md).
The implementation is [`packages/sources/src/capabilities.ts`](../../packages/sources/src/capabilities.ts)
and the shared extension wire validator is [`packages/sources/src/extension-config.ts`](../../packages/sources/src/extension-config.ts).
Both background and popup consumers use that validator. Capability, config,
source-catalogue, API, database-visibility, and MCP tests cover the local
contracts (the focused capability/config/visibility/API/MCP run passed 47 tests;
the affected extension consumer run passed 78); real Chrome/provider/
deployment acceptance remains separate.
