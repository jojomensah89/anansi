## What

<!-- One paragraph: what changed and why. -->

## Why

<!-- Link the issue (Closes #...) or explain the user-visible outcome. -->

## How I tested

- [ ] `bun test`
- [ ] `bun run typecheck`
- [ ] Extension: `bun run --cwd apps/extension compile` / `build` (if touched)
- [ ] Web: `bun run --cwd apps/web build` (if touched)
- [ ] MCP smoke: `bun run apps/web/scripts/mcp-http-smoke.ts` (if MCP/ingest touched)

## Privacy checklist

- [ ] No `.env`, `data/`, raw captures, media, cookies, or tokens committed
- [ ] New test fixtures scrubbed of real account data
- [ ] No new `<all_urls>` / `cookies` permissions or session exfiltration
