# MCP server page

## Request and observed state

The attached screenshot is a visual reference for an MCP setup page; it is not
additional implementation instructions. The application already exposes a
stateless Streamable HTTP MCP endpoint at `/mcp` and a matching stdio server.
The MCP implementation currently has four read-only tools:

- `search_memory`
- `get_item`
- `recent_saves`
- `find_by_author`

The configured `MCP_TOKEN` is a bearer secret. Current local verification shows
the stdio smoke test and the HTTP smoke test pass when the local server is
started with a token. An older process on port 8788 was started without the
token and returns the expected 503 configuration response; it is unrelated to
the implementation and must not be terminated by this feature.

## Chosen approach

Use the existing `/mcp` route for both the setup page and the MCP transport:

- `GET /mcp` renders the browser setup page.
- `POST /mcp` continues serving the existing MCP JSON-RPC transport with the
  current bearer-token validation and tool registration.

This keeps the client endpoint and existing POST-based configuration stable
while making the endpoint itself discoverable in the product. The page does
not fetch, render, or persist the raw `MCP_TOKEN`.

## Page experience

The page follows Anansi's existing dark UI rather than copying the light
reference literally.

1. A page header reads `MCP server` with a short explanation that connected
   agents can search the saved library through Anansi's read-only tools.
2. An endpoint card shows the current origin plus `/mcp`, a copy button, a
   `4 tools available` badge, and `Streamable HTTP · Bearer-key auth` metadata.
3. A connection card provides client choices for Claude Code, Claude Desktop,
   Cursor, VS Code, Windsurf, and Zed. The selected client changes the
   copyable setup snippet.
4. The setup snippet always uses the literal `<YOUR_MCP_TOKEN>` placeholder.
   Supporting text explains that it must be replaced with the token already
   configured for the Anansi server. The page never attempts to create,
   retrieve, hash, or store a key.
5. A tools card lists all four registered tool names and concise descriptions,
   making the page useful even before a client is connected.
6. The existing rail gains an `MCP server` navigation item with an active state
   when the pathname is `/mcp`.

The endpoint and setup snippets are rendered from constants and the browser
origin, not from a server secret. Copy actions use the Clipboard API when
available and show a short inline copied state; failure leaves the text
available for manual copying.

## Client snippets

The snippets are intentionally explicit and use the same endpoint for every
client. Client-specific differences are limited to the documented wrapper
format:

- Claude Code: `claude mcp add --transport http anansi <endpoint> --header
  "Authorization: Bearer <YOUR_MCP_TOKEN>"`
- Claude Desktop: JSON `mcpServers` entry with `type: "http"`, `url`, and an
  `Authorization` header.
- Cursor: JSON `mcp` entry with `url` and an `Authorization` header.
- VS Code: JSON `servers` entry with `type: "http"`, `url`, and headers.
- Windsurf and Zed: JSON HTTP-server entries with the same endpoint and bearer
  header.

The exact snippet is kept copyable and compact; no snippet includes a real
token, local database path, or other private environment value.

## Route and security boundaries

- Preserve `handleMcp` as the single implementation for MCP auth, transport,
  and tool registration.
- Keep the existing `POST /mcp` response behavior for missing and invalid
  bearer tokens.
- Remove only the browser-conflicting GET transport handler if the framework
  requires GET to render the page; the page route must not weaken POST auth.
- Do not add API-key creation, storage, token rotation, token disclosure, or a
  browser request that tests the secret against the server.
- The UI is a setup guide, not proof of remote deployment. Its status badge
  describes the configured local/server contract, while smoke-test results are
  reported separately.
- Preserve unrelated dirty worktree changes in the avatar and source-mark
  components.

## Responsive behavior and accessibility

- The content area scrolls independently of the rail.
- The endpoint card remains readable at narrow widths; metadata wraps below
  the endpoint instead of forcing horizontal overflow.
- The connection and tools cards stack below a desktop two-column layout.
- Client choices are real buttons with visible selected and keyboard-focus
  states.
- Copy controls are buttons with accessible labels and an inline status update.
- Code snippets use `pre`/`code` semantics and remain selectable on clipboard
  failure.
- The page heading is the single `h1`; card headings use `h2`.

## Verification and acceptance criteria

1. `GET /mcp` renders the setup page and `POST /mcp` still reaches the MCP
   transport.
2. The page has the requested endpoint, client setup, configured-token status,
   tool list, and sidebar navigation.
3. No raw token is present in rendered UI text, HTML, client-side source, or
   copied snippets; all snippets contain `<YOUR_MCP_TOKEN>`.
4. All four current tools are listed, and the count is derived from the same
   tool registry contract used by the MCP server.
5. Endpoint and snippet copy actions work when the Clipboard API is available
   and remain harmless when it is unavailable.
6. The page is usable on desktop and narrow layouts without horizontal
   overflow.
7. Existing avatar/source-icon changes are not altered or included in the MCP
   feature commit.

Run focused tests for the new page helpers/components, the full test suite, the
web production build, React Doctor, the existing stdio and HTTP MCP smoke
tests, and `git diff --check`. Report framework or repository baseline
diagnostics separately from feature results.
