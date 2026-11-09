# Security Policy

## Supported versions

Anansi is pre-1.0 (`0.1.x`). Security fixes ship on `main` and are noted in release notes. There is no LTS branch yet.

## Reporting a vulnerability

Do **not** open a public issue for suspected vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/jojomensah89/anansi/security/advisories/new) (preferred). Include:

- affected component (extension / web server / MCP / CLI / db)
- steps to reproduce or proof-of-concept
- impact (what an attacker can read / write)
- your environment (Bun version, browser, commit SHA)

We will acknowledge within 72 hours, keep you updated on a fix, and credit you on release unless you prefer anonymity.

## Scope notes

Anansi is intentionally conservative about browser access:

- No `<all_urls>` permission, no `cookies` permission.
- No GitHub OAuth or personal access token for extension capture.
- Library, extension and MCP access fail closed without credentials. Explicit
  `LIBRARY_TOKEN`, `INGEST_TOKEN` and `MCP_TOKEN` override `ANANSI_SECRET` for
  their respective roles during migration; otherwise the master secret is the fallback. Retiring legacy access disables these shared extension/MCP credentials.
- The local database and media live under `data/` and must never be committed.

Please do not submit reports asking for session-cookie exfiltration, token harvesting, or bypassing platform login — those are out of scope by design.

## Secrets hygiene

Never put `ANANSI_SECRET`, `INGEST_TOKEN`, `MCP_TOKEN`, or `LIBRARY_TOKEN` in
`VITE_*` vars, committed files, screenshots, or issue logs. Rotate any secret
that was ever pasted publicly. Use a separate ingest key for the extension to
limit its authority. Rotation requires reconnecting affected clients.

Default Chrome builds are public artifacts with no embedded deployment URL or
credential. Connect them through the popup. Explicit private build mode can embed
`ANANSI_EXTENSION_INGEST_TOKEN`; anyone with that artifact can extract it.
Never publish or share a private configured build. Rebuild after rotating its key.

## Request protection

The Worker uses separate Cloudflare rate-limit bindings for login, extension
requests and MCP. Counters are per Cloudflare location and eventually consistent,
not global quotas. Shared IP addresses share a budget. Missing or failing bindings
close those routes with 503; throttling returns 429 and a retry hint. Confirm the
bindings and any additional WAF rules on the deployed Worker before launch.

Capture relays run on provider pages. Same-page scripts are not trusted simply
because they know the relay nonce: it correlates messages, not authenticates a
provider. Source identity, bounded payloads and queue limits remain required.
See PRIVACY.md for capture destinations and optional AI processing.

## Connected clients
Stored keys use 256 random bits and SHA-256 hashes. Revocation is checked each request; last use updates at most every five minutes. API keys permit read-only MCP. Legacy shared credentials work only for capture or MCP until explicitly retired in Connected clients; owner login remains available.
First connection uses a five-minute single-use code pasted from the library into the popup. The popup requests optional origin permission and redeems directly. Keys never pass through MAIN-world scripts or the page bridge. Keep codes private. Existing queue destination guards preserve captures during reconnect.

OAuth apps use authorization codes with S256 PKCE and rotating refresh tokens.
Codes and tokens are SHA-256 hashes in D1. Access tokens are restricted to the
deployment's /mcp audience. Consent requires an owner session and same-origin
approval; bearer credentials cannot approve. Public OAuth POST routes use the
login rate limiter. Unapproved registrations expire after one day and are capped
at 200. Revocation is checked on every access and refresh request. No KV or extra
deployment secret is needed.
