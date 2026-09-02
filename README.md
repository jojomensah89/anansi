# Anansi

A memory layer over everything you save — built so your coding agent can query
it, not just so you can scroll it.

Day 1 of the build spec: **the importer**. No database, no cloud account, no
dependencies. It pages your X bookmarks, writes every raw payload to disk, and
normalizes them into a file you can re-run against.

## Quickstart

```bash
bun install
cp .env.example .env      # paste auth_token and ct0 from a logged-in x.com tab
bun run anansi doctor     # check the session and the endpoint resolution
bun run anansi import x --pages 1   # smoke test
bun run anansi import x   # the real thing
```

## Commands

| command | what it does |
|---|---|
| `anansi doctor` | session, queryId, bearer, last run, saved cursor |
| `anansi import x` | full backfill; raw pages to disk, normalized to `data/items-x.jsonl` |
| `anansi import x --since` | incremental; stops at the first page holding a known id |
| `anansi import x --resume` | continue from the saved cursor |
| `anansi reparse x` | re-run the parser over raw pages already on disk. No network. |
| `anansi stats x` | authors, media, date range, top ten |

## How it is put together

Three seams, placed on day 1 because the spec turns on them later:

**`CaptureAdapter` splits fetching from parsing.** `pages()` touches the
network; `parse()` is a pure function over a raw payload. So the parser is
developed offline against saved fixtures, a parser fix costs no re-fetch, and
the same `parse()` runs server-side when the extension starts POSTing raw
payloads to `/api/ingest`.

**`NormalizedItem` mirrors the `items` table one-for-one.** Day 2 is a mapping,
not a redesign.

**`SessionProvider` decides whose session makes the request.** Today: cookies
from `.env`. Later: a cookie-reading CLI, then the extension. Nothing above
that interface knows which one it got.

### Why cookies in `.env`, not a cookie-store reader

The spec flags it and this machine is the case that hits it: Chrome's
app-bound encryption on Windows makes reading the live cookie jar a project of
its own. Pasting two values takes ten seconds. The reader can arrive behind
the same interface whenever it earns its keep.

### The queryId

Not in the main bundle — in a lazily-loaded chunk. In a page you reach it
through `window.webpackChunk_twitter_responsive_web`; a CLI has no page, so
`endpoint.ts` fetches and scans the same public assets, one level deep, and
caches the result for 12 hours. Four tiers, most-trusted first: `.env`
override, disk cache, network scan, then a pinned value that logs loudly.

If a run comes back empty, `snippets/resolve.js` prints the current values
from a logged-in tab.

### Raw first, always

Every page is written to `data/raw/x/` before anything tries to understand it.
That is what makes `reparse` free, and it is why the day the payload shape
changes costs you a parser fix rather than a re-import.

### The one alarm

Every run appends to a ledger in `data/checkpoint-x.json`. A run that returns
zero items after a run that didn't exits non-zero and says so. That single
check is the difference between a tool and a tool you trust.

## What is deliberately not here yet

SQLite (day 2), FTS5 search (day 3), the MCP server (day 4), GitHub (day 5),
media to R2 (day 6–7). `src/adapters/github/` is an empty directory waiting.

## Terms

Automated access to X outside the official API is against their developer
terms. Every request this tool makes is made from your machine, with your own
session, against your own account. That is not the same as being in the clear.
