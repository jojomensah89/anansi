# Contributing to Anansi

Anansi is a self-hosted library for supported browser saves, web pages and GitHub stars, searchable through the web app and eight read-only MCP tools.

## Setup

Use Bun 1.4.2+ and Chrome for the current release target. Run `bun install --frozen-lockfile`, copy .dev.vars.example to .dev.vars, set ANANSI_SECRET to a generated random secret, and run `bun run dev`. This builds the Worker and applies local migrations before starting it.
Optional LIBRARY_TOKEN, INGEST_TOKEN and MCP_TOKEN override their respective roles. Open http://127.0.0.1:8787; API is /api and MCP is /mcp. Follow the README for Cloudflare setup.
AI is optional and uses Cloudflare bindings. Historical Ollama/CLI commands are not current runtime paths. Never run db:push; canonical SQL migrations in packages/db/drizzle include FTS5 tables and triggers.

Build the public extension with `bun run --cwd apps/extension build`, load apps/extension/.output/public/chrome-mv3 and connect through the popup. See apps/extension/README.md.

## Checks

```powershell
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension zip
bun run --cwd apps/extension check:public-artifact
bun run build
bun run apps/web/scripts/launch-feature-smoke.ts
git diff --check
```

Synthetic smoke uses isolated memory data. Automated checks do not prove signed-in provider capture, live Workers AI or fresh-account Cloudflare installation. See release/chrome/README.md for release gates.

## Project map

- apps/extension: capture, queue, imports and popup.
- apps/web: TanStack Start UI, JSON API and HTTP MCP.
- packages/db: SQLite/D1 schema, migrations and library operations.
- packages/mcp: eight read-only tools and shared server.
- packages/sources: capture contracts, capabilities and parsers.
- packages/ui and packages/env: shared UI and runtime binding types.
- wrangler.jsonc: resources, scheduling and request protection.
- release/chrome: submission materials and acceptance evidence.

The extension captures and queues; the server validates and parses; the database owns identity, search and provenance. Workspace packages stay private implementation units.

## Privacy and support

Never commit environment files, real library data, cookies, private captures, media or credentials. Use synthetic or scrubbed fixtures. Do not add mandatory all-site access or a cookies API permission. Browser session cookies must never be uploaded to Anansi.
Report bugs using .github/ISSUE_TEMPLATE with browser/Bun version, source, reproduction steps and redacted logs. Report vulnerabilities privately per SECURITY.md. Read PRIVACY.md before changing data destinations.
