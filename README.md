# Anansi

Anansi is a local-first memory layer for the things you save online. It captures bookmarks, saved posts, favourites, GitHub stars, and web pages into one searchable library that your coding agent can query through MCP.

It is designed for personal use: your browser supplies the platform session, Anansi stores the capture, and the server exposes only the library you choose to connect.

## Status

| Source | Capture | Status |
| --- | --- | --- |
| X bookmarks | History import + live saves | Supported |
| Reddit saves | History import + live saves | Supported |
| GitHub stars | Full import + live star/unstar events | Supported |
| Web pages | Toolbar, context menu, and selection capture | Supported |
| Chrome bookmarks | Optional mirroring into the web library | Supported |
| TikTok favourites | Observe while browsing your favourites | Experimental |

GitHub capture is extension-only. It reads the signed-in GitHub stars pages in your browser, includes repositories that are visible to that account—including visible private repositories—and does not require GitHub OAuth or a personal access token.

## Quick start

### Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- A Chromium-based browser for the extension
- A local SQLite database (created automatically)

### 1. Install dependencies

```bash
bun install
```

### 2. Start the local server

Copy the example environment file and set both tokens. The ingest token authenticates the browser extension; the MCP token authenticates agent clients.

PowerShell:

```powershell
Copy-Item .env.example .env
# Edit .env and set INGEST_TOKEN and MCP_TOKEN.
bun run apps/web/scripts/serve-local.ts
```

The local server listens on `http://127.0.0.1:8788` and creates `data/anansi.db` on first start.

To run the web interface against that local server, use a second terminal:

```powershell
$env:VITE_API_BASE = "http://127.0.0.1:8788"
bun run dev:web
```

Then open the Vite URL printed in the terminal.

### 3. Build and load the extension

```bash
bun run --cwd apps/extension build
```

Open your browser's extension page, enable Developer mode, choose **Load unpacked**, and select:

```text
apps/extension/.output/chrome-mv3
```

Open the Anansi extension popup and enter:

- Server: `http://127.0.0.1:8788`
- Ingest token: the value of `INGEST_TOKEN`

Click **Save**. The popup will load the configured sources and show queue, import, and connection status.

## Capturing GitHub stars

1. Sign in to GitHub in the same browser profile where Anansi is installed.
2. Open the Anansi popup and choose **Import** beside GitHub.
3. Anansi opens GitHub's signed-in stars page, follows the full repository list, and queues each bounded repository record.
4. Leave the browser session available while the first import runs. Progress and the pagination cursor are persisted, so an interrupted run can resume.

After the initial import, successful GitHub star and unstar actions are captured automatically. Repository identity is normalized as lowercase `owner/repository`, so a repository is stored once even when GitHub changes its display casing. Unstarring removes it from the current-star view without deleting the saved record; starring it again restores the current state.

An import contains repository metadata such as:

- Repository name and URL
- Description and primary language, when available
- Star and fork counts
- Starred date, when GitHub provides it
- Public/private visibility
- Owner avatar, with a safe fallback when GitHub does not render one

Only data visible in the signed-in GitHub page is captured. The extension does not send cookies, passwords, page forms, or raw HTML, and it does not request GitHub account access.

## Extension sources

The extension uses the existing browser session and sends bounded capture payloads to the authenticated Anansi ingest endpoint.

- **X** walks the bookmarks page and watches bookmark mutations.
- **Reddit** walks the saved-post listing and watches save/unsave requests.
- **GitHub** walks the signed-in stars pages and watches star/unstar requests.
- **TikTok** observes data already fetched while the signed-in favourites view is open; it has no history import and remains experimental.
- **Web** captures the current page or selection from the toolbar and context menu.
- **Chrome bookmarks** can be mirrored after granting the optional bookmarks permission.

Automatic sync can be set to off, hourly, every two hours, every six hours, or daily. Live saves are queued immediately; scheduled imports open a background tab when needed and close only tabs created by Anansi.

## MCP server

Anansi exposes the same library through a Streamable HTTP MCP server at:

```text
http://127.0.0.1:8788/mcp
```

Bearer authentication is required when `MCP_TOKEN` is configured. The web app also includes an `/mcp` setup page that uses the literal `<YOUR_MCP_TOKEN>` placeholder; it never displays the configured secret.

The MCP server provides four read-focused tools:

| Tool | Purpose |
| --- | --- |
| `search_memory` | Search saved items and return ranked excerpts with source URLs |
| `get_item` | Retrieve one saved item with text, links, media, and thread context |
| `recent_saves` | List the newest saved items |
| `find_by_author` | Find saved items from one author |

For Claude Code:

```bash
claude mcp add --transport http anansi http://127.0.0.1:8788/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"
```

For Codex or another client that supports an environment-backed bearer token:

```toml
[mcp_servers.anansi]
url = "http://127.0.0.1:8788/mcp"
bearer_token_env_var = "MCP_TOKEN"
```

Keep `MCP_TOKEN` in the client environment rather than committing it to a project file.

## Local API

The local server provides JSON endpoints for the library and extension:

```text
GET  /api/stats
GET  /api/items
GET  /api/items/:id
GET  /api/search?q=...
GET  /api/recent
GET  /api/authors?handle=...
GET  /api/creators
GET  /api/sources
POST /api/ingest
POST /api/extension/heartbeat
GET  /api/extension/config
```

`POST /api/ingest` and the extension heartbeat require the `INGEST_TOKEN` bearer token. Ingest is closed when no token is configured.

## CLI

The CLI remains useful for local database and parser work:

```bash
bun run anansi --help
bun run anansi db migrate
bun run anansi search "design system"
bun run anansi recent --limit 20
bun run anansi media sync
bun run anansi serve --mcp
```

The browser extension is the recommended capture path. The CLI also contains source adapters for local experiments and reparsing raw captures already on disk.

## Project structure

```text
apps/cli/        Local CLI, import adapters, database and stdio MCP entrypoint
apps/extension/  WXT React MV3 extension and platform content scripts
apps/web/        TanStack Start UI, JSON API, MCP HTTP route, local server
packages/db/     SQLite/D1 schema, migrations, search, and item operations
packages/mcp/    Transport-independent MCP server and tool definitions
packages/sources/  Shared capture contracts and source parsers
packages/ui/     Shared UI components and styles
packages/infra/  Cloudflare infrastructure and deployment resources
packages/env/    Typed runtime environment bindings
```

The durable boundaries are intentional: the extension captures and queues; the server validates and parses; the database owns identity, search, removal state, and provenance; MCP and HTTP call the same database functions.

## Development commands

```bash
bun test
bun run typecheck
bun run --cwd apps/extension compile
bun run --cwd apps/extension build
bun run --cwd apps/web build
```

To exercise the local MCP HTTP transport:

```bash
bun run apps/web/scripts/mcp-http-smoke.ts
```

The local test suite covers queue recovery, retry behavior, parser fixtures, authenticated ingest, GitHub import/live transitions, search, source health, and repository-card rendering.

## Privacy and permissions

Anansi is intentionally conservative about browser access:

- No `<all_urls>` permission
- No `cookies` permission
- No GitHub OAuth flow or GitHub personal access token for extension capture
- Platform requests run from the signed-in page that already owns the session
- Raw payloads are bounded and validated before server-side parsing
- Extension-to-server traffic uses bearer authentication
- Chrome bookmark access is optional and requested only when mirroring is enabled

The local database and downloaded media live under `data/`. Do not commit `.env`, database files, raw captures, or media.

## License

MIT
