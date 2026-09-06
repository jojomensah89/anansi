<div align="center">

# 🕸️ Anansi

**Your personal web memory in your own Cloudflare account — free tier, ~$0. Local SQLite for dev, Worker + D1 + R2 for hosting.**

Anansi captures the things you save online — bookmarks, saved posts, GitHub stars, web pages — into one searchable library your coding agent can query over MCP. Your browser supplies the platform session; your Cloudflare account (or a local SQLite file for dev) stores the capture.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black?logo=bun)](https://bun.sh)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](./package.json)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Free--tier-orange?logo=cloudflare)](https://github.com/jojomensah89/anansi)
[![Local SQLite dev](https://img.shields.io/badge/Local--dev-SQLite-green)](./README.md)
[![Repo](https://img.shields.io/badge/GitHub-jojomensah89%2Fanansi-black?logo=github)](https://github.com/jojomensah89/anansi)
<!-- PUBLIC LAUNCH: uncomment after repo goes public -->
<!-- [![Stars](https://img.shields.io/github/stars/jojomensah89/anansi?style=social)](https://github.com/jojomensah89/anansi) -->
<!-- [![Issues](https://img.shields.io/github/issues/jojomensah89/anansi)](https://github.com/jojomensah89/anansi/issues) -->
<!-- [![Last commit](https://img.shields.io/github/last-commit/jojomensah89/anansi)](https://github.com/jojomensah89/anansi/commits) -->
<!-- [![CI](https://github.com/jojomensah89/anansi/actions/workflows/ci.yml/badge.svg)](https://github.com/jojomensah89/anansi/actions/workflows/ci.yml) -->

[Get Started](#-quickstart) · [Supported Sources](#-supported-sources) · [Ask it from your agent](#-ask-it-from-your-agent-mcp) · [Report a bug](https://github.com/jojomensah89/anansi/issues/new?template=bug_report.yml)

<!-- TODO: add hero visual — docs/assets/demo.gif + library screenshot -->

</div>

## ✨ Why Anansi?

Bookmarks rot across X, Reddit, GitHub, TikTok, and 200 open tabs. Pocket-style tools own your data, and agents can't read them.

Anansi fixes that:

- 📥 **Capture where you browse** — extension uses your existing signed-in session, no scraping service
- 💸 **~$0 hosting in your account** — one Worker, one D1, one R2. No server to babysit, no account controlled by anyone else, no paid Queues or Durable Objects by design
- 🔍 **One searchable library** — full text, authors, recency, source filters
- 🏷️ **Organize your way** — manual tags (bulk included), saved filter collections, highlights, private notes, favorites
- 🧠 **Agent-native** — Streamable HTTP MCP server with 4 read-focused tools
- 🔒 **Conservative by design** — bearer-auth ingest, no `<all_urls>`, no `cookies` permission, no GitHub OAuth/PAT
- 🔁 **Durable** — queued capture with retry + resume cursors, survives restarts and rate limits

## 📥 Supported Sources

| Source | Capture | Status |
| --- | --- | --- |
| X bookmarks | History import + live saves | Supported |
| Reddit saves | History import + live saves | Supported |
| GitHub stars | Full import + live star/unstar events | Supported |
| Web pages | Toolbar, context menu, and selection capture | Supported |
| Chrome bookmarks | Optional mirroring into the web library | Supported |
| TikTok favourites | Observe while browsing your favourites | Experimental |

> GitHub capture is extension-only. It reads the signed-in GitHub stars pages in your browser, includes repositories visible to that account — including visible private repositories — and needs no GitHub OAuth or personal access token.

Live saves are delivered immediately. Anansi also performs one daily incremental catch-up for sources that support history import, covering changes made while Chrome or the extension was inactive. GitHub and Reddit import via background session requests without opening tabs. X may use a signed-in inactive tab; TikTok remains observation-based. Anansi closes only tabs it created. If a provider session is missing, the popup asks you to sign in — use the explicit **Sign in** button, then retry. Network and rate-limit failures keep the resume cursor.

## 🚀 Quickstart

Two paths, same library: run it locally or host it in your own Cloudflare account.

### A. Local

Requirements: [Bun](https://bun.sh/) 1.3+, Chromium-based browser. SQLite DB is created automatically.

```bash
bun install
cp .env.example .env
# Edit .env and set three independent server secrets:
#   LIBRARY_TOKEN, INGEST_TOKEN, MCP_TOKEN
# Then mirror INGEST_TOKEN into ANANSI_EXTENSION_INGEST_TOKEN.
# Keep ANANSI_EXTENSION_ORIGIN=http://127.0.0.1:3001
bun run dev:local
```

Open `http://127.0.0.1:3001`. This is the one public local origin: the library is at `/`, JSON endpoints are under `/api`, and MCP is at `/mcp`. The launcher creates `data/anansi.db` on first start and prints the local library sign-in token.

An internal Bun process listens on port `8788` because Vite's Node runtime cannot load Bun's SQLite implementation. Vite proxies `/api` and `/mcp` to it. Do not enter or configure port `8788` anywhere.

Build the private extension in a second terminal:

```bash
bun run --cwd apps/extension build
```

Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose `apps/extension/.output/chrome-mv3`. The extension connects immediately; there is no server or token field in the popup.

> The configured build contains your ingest credential. This is appropriate for your private, load-unpacked extension, but anyone with the artifact can extract it. Never upload this configured build to a public extension store or share it.

GitHub first import: sign in to GitHub in the same browser profile → popup → **Import** beside GitHub. It walks your stars pages in the worker (no tabs open), persists the pagination cursor, and resumes after interruptions. Unstarring hides from current-star view without deleting history; re-starring restores it.

### B. Cloudflare — your account, ~$0 (preview, not yet verified)

> ⚠️ The hosted path is the intended shape — one Worker, one D1, one R2, deployed with `bun run deploy` — but no clean-account deploy has succeeded yet. Treat this section as the plan, not instructions. First verified deploy will turn it into real steps.

The shape (`packages/infra/alchemy.run.ts`): D1 holds searchable metadata and text (migrations live in `packages/db/drizzle`, never `db:push` — the FTS5 virtual table and triggers need the migration path); R2 holds accepted image copies; retry state lives in D1 in small batches via request `waitUntil` plus scheduled recovery, so there is nothing paid to provision. Three separate secrets gate the three doors: `LIBRARY_TOKEN` (web UI session), `INGEST_TOKEN` (extension), `MCP_TOKEN` (agents). Absent means closed, never open.

Cloudflare credentials for deploy (unverified — least-privilege list to be confirmed on first successful deploy):

```bash
# Interactive login (recommended locally — no manual token):
bunx alchemy login --configure   # run from packages/infra

# CI / headless instead needs:
# CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
# The stack implies Workers Scripts, D1, and R2 scopes plus the
# alchemy state-store worker. Create the token at
# dash.cloudflare.com → Profile → API Tokens; prefer a scoped token
# over a superuser token.
```

Server secrets (same `.env` keys as local):

```bash
cp .env.example .env
# Set LIBRARY_TOKEN, INGEST_TOKEN, MCP_TOKEN — independent random secrets.
# Never put them in VITE_* vars or commit them.
bun run deploy   # turbo → @anansi/infra → alchemy deploy
```

After deployment returns `https://<worker>.workers.dev`:

1. Set `ANANSI_EXTENSION_ORIGIN=https://<worker>.workers.dev` in your local `.env`.
2. Set `ANANSI_EXTENSION_INGEST_TOKEN` to the same value deployed as `INGEST_TOKEN`.
3. Run `bun run --cwd apps/extension build`.
4. Load `apps/extension/.output/chrome-mv3` from `chrome://extensions`.
5. Open the popup and confirm all sources appear and the library is connected.
6. Use **Open library**, sign in with `LIBRARY_TOKEN`, and verify one page capture.
7. Sign into each provider in the same Chrome profile before its first import.

The Worker is the only public origin: the library is `/`, the API is `/api/*`, and MCP is `/mcp`. There are no deployed ports to configure.

## 🧠 Ask it from your agent (MCP)

Streamable HTTP MCP server at `http://127.0.0.1:3001/mcp` locally (or `https://<worker>.workers.dev/mcp` when hosted). Bearer auth with `MCP_TOKEN` when configured. The web `/mcp` setup page uses a literal `<YOUR_MCP_TOKEN>` placeholder and never prints the secret.

| Tool | Purpose |
| --- | --- |
| `search_memory` | Search saved items, ranked excerpts + source URLs |
| `get_item` | One item with text, links, media, thread context |
| `recent_saves` | Newest saved items |
| `find_by_author` | Items from one author |

Claude Code:

```bash
claude mcp add --transport http anansi http://127.0.0.1:3001/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"
```

Codex / env-backed clients:

```toml
[mcp_servers.anansi]
url = "http://127.0.0.1:3001/mcp"
bearer_token_env_var = "MCP_TOKEN"
```

Keep `MCP_TOKEN` in the client environment, never in a committed file.

## 🏗️ How it works

```mermaid
flowchart LR
  B[Browser extension<br/>session capture + queue] -->|POST /api/ingest<br/>INGEST_TOKEN| S[Web server<br/>validate + parse]
  S -->|local dev| L[(data/anansi.db<br/>SQLite + FTS5)]
  S -->|hosted| D[(D1<br/>meta + text + retry state)]
  S -->|hosted| R[(R2<br/>accepted image copies)]
  L --> W[Web library UI]
  D --> W
  L --> M[MCP server<br/>search / get / recent / by-author]
  D --> M
  M --> A[Claude / Codex / agent]
```

Durable boundaries: extension captures and queues; server validates and parses; database owns identity, search, removal state, and provenance; MCP and HTTP call the same database functions.

<details>
<summary><strong>Project structure & local API</strong></summary>

```text
apps/cli/          Local CLI, import adapters, database and stdio MCP entrypoint
apps/extension/    WXT React MV3 extension and platform content scripts
apps/web/          TanStack Start UI, JSON API, MCP HTTP route, local server
packages/db/       SQLite/D1 schema, migrations, search, and item operations
packages/mcp/      Transport-independent MCP server and tool definitions
packages/sources/  Shared capture contracts and source parsers
packages/ui/       Shared UI components and styles
packages/infra/    Cloudflare infrastructure and deployment resources
packages/env/      Typed runtime environment bindings
```

```text
GET  /api/stats   GET /api/items   GET /api/items/:id   GET /api/search?q=...
GET  /api/recent  GET /api/authors?handle=...           GET /api/creators
GET  /api/sources POST /api/ingest POST /api/extension/heartbeat
GET  /api/extension/config
```

`POST /api/ingest` and heartbeat require `INGEST_TOKEN`. Ingest is closed when no token is configured.

CLI for local DB / parser work:

```bash
bun run anansi --help
bun run anansi db migrate
bun run anansi search "design system"
bun run anansi recent --limit 20
bun run anansi media sync
bun run anansi serve --mcp
```

</details>

## 🔒 Privacy by design

- No `<all_urls>` permission · No `cookies` permission · No GitHub OAuth / PAT for extension capture
- GitHub + Reddit use browser-managed session cookies; X + TikTok use signed-in page scripts. Cookie values are never read or uploaded.
- Raw payloads are bounded and validated before server-side parsing; extension traffic is bearer-authed
- Chrome bookmark access is optional, requested only when mirroring is enabled
- Local DB + media live under `data/` (local dev); D1 + R2 in your account (hosted). Never commit `.env`, database files, raw captures, or media.

## 🛠️ Development

```bash
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
bun run apps/web/scripts/mcp-http-smoke.ts
```

Covers queue recovery, retries, parser fixtures, authenticated ingest, GitHub import/live transitions, search, source health, and card rendering. See [CONTRIBUTING.md](./CONTRIBUTING.md) — scrub fixtures before committing.

## 🗺️ Roadmap

- [ ] 🔍 Semantic search via Cloudflare Vectorize — hybrid BM25 + vectors. Free tier covers a personal library (~10k items × 384-dim ≈ 3.8M of 5M free stored dims/month); to be measured on first deploy
- [ ] 🤖 AI tagging via Workers AI — suggestions stored with `origin: 'ai'` so manual tags stay authoritative (10k neurons/day free; backfill paced over days)
- [ ] 🗂️ Collections v2 — curated hand-picked lists alongside today's saved filter views
- [ ] First clean-account deploy: install → migrate → first capture → search → export → restore against Cloudflare
- [ ] Measured free-tier usage + media-host allowlist published here
- [ ] Synthetic demo library
- [ ] More supported sources (TikTok graduates from experimental)

Have an idea? [Open a feature request](https://github.com/jojomensah89/anansi/issues/new?template=feature_request.yml).

## 🤝 Contributing

PRs welcome — small and focused wins. Read [CONTRIBUTING.md](./CONTRIBUTING.md), follow the privacy rules, run the checks above. Report vulnerabilities privately per [SECURITY.md](./SECURITY.md). Be kind per [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## 📄 License

MIT © 2026 Jojo Mensah — see [LICENSE](./LICENSE).

---

Built by [Jojo Mensah](https://x.com/jojomensah89) <a href="https://x.com/jojomensah89"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/x/follow/jojomensah89.svg?variant=branded&size=xs" /><img src="https://shieldcn.dev/x/follow/jojomensah89.svg?variant=branded&size=xs&theme=zinc" alt="X Follow" /></picture></a> · Follow along for demos and changelogs · [☕ Buy me a coffee](https://buymeacoffee.com/jojomensahh)
