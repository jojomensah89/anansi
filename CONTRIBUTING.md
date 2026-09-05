# Contributing to Anansi

Thanks for picking up Anansi. It is a local-first memory layer for the things you save online — bookmarks, saved posts, GitHub stars, and web pages — searchable by you and your coding agent over MCP.

## Quick setup

Requirements: [Bun](https://bun.sh/) 1.3+, a Chromium-based browser for the extension.

```bash
bun install
cp .env.example .env
# Edit .env and set INGEST_TOKEN and MCP_TOKEN (LIBRARY_TOKEN for the web UI)
bun run apps/web/scripts/serve-local.ts
```

In a second terminal (web UI against the local server):

```bash
$env:VITE_API_BASE = "http://127.0.0.1:8788"  # PowerShell; export on bash
bun run dev:web
```

Build and load the extension:

```bash
bun run --cwd apps/extension build
```

Then `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/.output/chrome-mv3`. Enter Server `http://127.0.0.1:8788` + your `INGEST_TOKEN` in the popup.

## Checks before you push

```bash
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
bun run apps/web/scripts/mcp-http-smoke.ts
```

Keep PRs small and focused. Include what changed, why, and how you tested it.

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
```

Boundary: extension captures and queues; server validates and parses; database owns identity, search, and provenance; MCP and HTTP call the same database functions.

## Privacy rules (must-follow)

- Never commit `.env`, `data/`, raw captures, downloaded media, cookies, tokens, or session values.
- No `<all_urls>` or `cookies` permission. No GitHub OAuth / PAT for extension capture. GitHub and Reddit imports use browser-managed session cookies — never read or upload cookie values.
- Test fixtures ARE committed, but only after scrubbing. See `fixtures/README.md` if present, otherwise open an issue before adding a new fixture containing real account data.

## Filing issues

Use the bug / feature templates in `.github/ISSUE_TEMPLATE/`. Include Bun version, source (X / Reddit / GitHub / TikTok / Web), repro steps, and redacted logs. Never paste tokens or private saved content.
