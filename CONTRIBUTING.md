# Contributing to Anansi

Thanks for picking up Anansi. It is a local-first memory layer for bookmarks,
saved posts, GitHub stars, and web pages, searchable by you and your coding
agent over MCP.

## Quick setup

Requirements: [Bun](https://bun.sh/) 1.3+, a Chromium-based browser for the
extension. Ollama is optional unless you are testing local AI.

```powershell
bun install
Copy-Item .env.example .env
# Set independent LIBRARY_TOKEN, INGEST_TOKEN, and MCP_TOKEN values.
bun run dev:local
```

Open `http://127.0.0.1:3001`. This is the only browser-facing local origin;
the launcher proxies `/api` and `/mcp` to its internal Bun process. Do not set
`VITE_API_BASE`, use port `8788` in the browser, or enter a token in the
extension popup.

Build and load the private extension:

```powershell
bun run --cwd apps/extension build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `apps/extension/.output/chrome-mv3`. The build uses
`ANANSI_EXTENSION_ORIGIN` and `ANANSI_EXTENSION_INGEST_TOKEN` from the local
environment; the credential is extractable, so never publish or share this
configured artifact.

## Local AI and acceptance

Local AI is an explicit developer path. Install Ollama, then pull the models
listed in `.env.example` (`embeddinggemma` and
`qwen3:4b-instruct-2507-q4_K_M`). With the daemon running:

```powershell
bun run ai:tagging:ollama
bun run semantic:ollama
bun run e2e:local
```

The end-to-end command creates a temporary SQLite database and synthetic
bookmark, then proves authenticated ingest/idempotency, background tag and
embedding completion, exact FTS5/BM25 search, semantic search, extension
configuration, and HTTP plus stdio MCP. It never touches `data/anansi.db`.

FTS5/BM25 is the default keyword path: terms are quoted and implicitly ANDed,
English stemming is enabled, a trailing `*` performs prefix matching, and
misspellings are not fuzzy-matched. Semantic search is optional and falls back
to the lexical page while Ollama is unavailable or its sidecar is warming.

## Checks before you push

```powershell
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
bun run apps/web/scripts/mcp-http-smoke.ts
```

The default suite does not require Ollama, Cloudflare credentials, or network
access. The Cloudflare acceptance procedure is opt-in and documented in
[`docs/superpowers/plans/2026-09-07-alchemy-semantic-smoke-runbook.md`](./docs/superpowers/plans/2026-09-07-alchemy-semantic-smoke-runbook.md).

## MCP

The local HTTP endpoint is `http://127.0.0.1:3001/mcp` and requires
`MCP_TOKEN`. The same four read-only tools are available over stdio:

```powershell
$env:ANANSI_DB_PATH = ".\data\anansi.db"
bun apps/cli/src/cli.ts serve --mcp
```

MCP search is intentionally keyword/BM25 today. The visible source filter
accepts `x`, `reddit`, `github`, and `web`; paused TikTok rows remain hidden.

## Project map

```text
apps/cli/         Local CLI, import adapters, database and stdio MCP entrypoint
apps/extension/   WXT React MV3 extension and platform content scripts
apps/web/         TanStack Start UI, JSON API, MCP HTTP route, local server
packages/db/      SQLite/D1 schema, migrations, search, and item operations
packages/mcp/     Transport-independent MCP server and tool definitions
packages/sources/ Shared capture contracts and source parsers
packages/ui/      Shared UI components and styles
packages/infra/   Cloudflare infrastructure and deployment resources
packages/env/     Typed runtime environment bindings
scripts/          Explicit local smoke and development entrypoints
```

The root package and workspace packages are private implementation units; the
repository is the OSS distribution. Do not publish a workspace package or
change `private` metadata without a separate package-distribution design.

Boundary: the extension captures and queues; the server validates and parses;
the database owns identity, search, and provenance; MCP and HTTP call the same
database functions.

## Privacy rules (must-follow)

- Never commit `.env`, `data/`, raw captures, downloaded media, cookies,
  tokens, or session values.
- No `<all_urls>` or `cookies` permission. No GitHub OAuth/PAT for extension
  capture. GitHub and Reddit imports use browser-managed session cookies —
  never read or upload cookie values.
- Test fixtures are committed only after scrubbing. See
  `apps/cli/fixtures/README.md` before adding account-derived data.

## Filing issues

Use the bug and feature templates in `.github/ISSUE_TEMPLATE/`. Include the Bun
version, source (X / Reddit / GitHub / TikTok / Web), repro steps, and redacted
logs. Never paste tokens or private saved content.
