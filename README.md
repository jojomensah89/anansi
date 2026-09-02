# Anansi

A memory layer over everything you save — built so your coding agent can query
it, not just so you can scroll it.

Day 1 of the build spec: **the importer**. No database, no cloud account, no
dependencies. It pages your X bookmarks, writes every raw payload to disk, and
normalizes them into a file you can re-run against.

## Quickstart

```bash
bun install
bun run anansi ingest
```

Then paste the printed snippet into the console of a logged-in x.com tab with
Bookmarks open. That is the whole setup. **You never handle a credential.**

A small bridge window opens; keep it open until the import finishes. If your
popup blocker eats it, the snippet saves `anansi-bookmarks.json` to your
downloads instead — then `anansi ingest --file <path>`.

### Why a bridge window

x.com's CSP `connect-src` has no `127.0.0.1`, and console-evaluated code runs
in page context under the page's CSP, so the snippet cannot POST here
directly:

```
Connecting to 'http://127.0.0.1:8787/ingest' violates the following
Content Security Policy directive: "connect-src 'self' blob: ..."
```

That rules out the bookmarklet-POSTs-to-localhost shape the build spec
assumed. CSP governs *connections*, not *windows* — so the snippet opens
`/bridge` on Anansi's own origin, and the payload crosses by `postMessage`,
which is not a connection. The bridge, being same-origin with the server,
POSTs freely. It only accepts messages whose origin is `https://x.com`.

The extension will need none of this: a content script's fetches are bound by
the extension's CSP, not the page's. This is the zero-install path until then.

## Commands

| command | what it does |
|---|---|
| `anansi ingest` | the capture path: loopback receiver + a snippet for the browser |
| `anansi reparse x` | re-run the parser over raw pages already on disk. No network. |
| `anansi stats x` | authors, media, date range, top ten |
| `anansi doctor` | endpoint resolution, last run, saved cursor |
| `anansi import x` | headless capture for your own machine only — see below |

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

### Why the browser makes the request

Because that is where the session already is. `credentials: "include"` makes
the browser attach its own cookie jar; ct0 is read in-page for the CSRF header
exactly as x.com's own code does, and never leaves the tab. What crosses to
the loopback server is the untouched bookmark payload and nothing else.

The alternative — reading `auth_token` out of DevTools into a `.env` — asks a
person to handle a live credential for their entire account, to do a thing
their browser is already authorised to do. It is not a setup step anyone
should be given.

This is also the extension's design, arriving early: browser fetches with the
user's session, POSTs raw, server parses. When the extension replaces the
snippet, only the sender changes.

### The queryId

Not in the main bundle — it lives in a lazily loaded chunk, reachable through
`window.webpackChunk_twitter_responsive_web`. In the page that walk is two
lines and always current, which is another reason capture belongs there.

Measured, not assumed: fetching x.com from a CLI without cookies returns the
**logged-out shell**, whose chunk graph is `LoggedOutShell` and never
references Bookmarks. The bearer is reachable that way; the queryId is not and
cannot be. `endpoint.ts` still exists for the headless path below, with four
tiers (env, disk cache, network scan, pinned) and loud logging when it falls
back.

### The headless path, and who it is for

`anansi import x` reads cookies from `.env` and makes the requests itself. It
exists for one case: a cron job on your own machine, against your own account,
where no browser is open to paste into. It is not documented for users, it is
not in the quickstart, and `.env.example` says so.

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
