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
- Extension-to-server traffic requires `INGEST_TOKEN` bearer auth; MCP requires `MCP_TOKEN` when configured.
- The local database and media live under `data/` and must never be committed.

Please do not submit reports asking for session-cookie exfiltration, token harvesting, or bypassing platform login — those are out of scope by design.

## Secrets hygiene

Never put `INGEST_TOKEN`, `MCP_TOKEN`, or `LIBRARY_TOKEN` in `VITE_*` vars, committed files, screenshots, or issue logs. Rotate any secret that was ever pasted publicly.
