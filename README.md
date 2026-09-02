# Anansi

A memory layer over everything you save — built so your coding agent can query
it, not just so you can scroll it.

Days 1–2 of the build spec: **the importer and the local library**. No cloud
account, no server. It pages your X bookmarks in your own browser, writes
every raw payload to disk, and normalizes them into a local SQLite file with
FTS5 already indexed.

```
apps/cli/        the importer, adapters, ingest receiver
packages/db/     schema, migrations, the driver-taking db module
```

Bun workspaces, laid out the way Better-T-Stack does, so day 8-9 adds
`apps/web` as a merge rather than a migration. No `apps/server`: the MCP tools
and the HTTP routes must call the same functions, and that is an import, not
a network hop.

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
| `anansi search "<q>"` | bm25-ranked keyword search, snippet highlighted |
| `anansi recent` | newest saves first |
| `anansi db migrate` | create or update `data/anansi.db` |
| `anansi db creators` | top authors, as a group-by |
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

### The database

One `items` table for every source, with the platform payload kept in `raw`,
so a new adapter is a parser rather than a migration. No `user_id` column —
this is a single-tenant library, and that column arrives when there is a
second user.

FTS5 is external-content (`content='items'`), so the index stores no second
copy of the text. That makes its three sync triggers mandatory rather than
decorative, and it is why **`db:push` is unsafe here** — push diffs the
Drizzle DSL and knows nothing about a virtual table. Generate and migrate.

Upserts are idempotent on `(source, external_id)`. A row's `id` is generated
once and never overwritten, and `saved_at` may only move backwards or toward
being exact, so re-importing does not march every item's saved date forward.

### Search, and where it stops working

FTS5 with BM25 and `snippet()`. Porter stemming works — searching *streaming*
finds *Stream*. Every term is quoted before binding, because `match` throws on
an apostrophe, a bare `*`, an unbalanced quote or the bare word `AND`, and a
thrown query inside an MCP call looks to an agent like the library is broken.
`search.test.ts` holds those inputs; a trailing `*` and an explicit "phrase"
are kept as real affordances.

**It does not work for CJK.** `unicode61` splits on non-alphanumeric
characters, and Japanese has no spaces, so a whole run becomes one token:

```
query            FTS  LIKE
デザイン           0     1   <- invisible to search
UIデザイン          0     1   <- invisible to search
```

That is 496 items, 39% of this library. `scripts/probe-cjk.ts` measures it.
The fix is either a second FTS table using the `trigram` tokenizer, or the
vectors the spec defers to phase 2 — this is the "keyword search visibly
fails" trigger it describes, arriving earlier than expected.

## What is deliberately not here yet

The MCP server (day 4), GitHub (day 5), media to R2 (day 6-7).
`apps/cli/src/adapters/github/` is an empty directory waiting.

## Terms

Automated access to X outside the official API is against their developer
terms. Every request this tool makes is made from your machine, with your own
session, against your own account. That is not the same as being in the clear.
