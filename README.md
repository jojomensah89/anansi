# Anansi

A memory layer over everything you save — built so your coding agent can query
it, not just so you can scroll it.

Days 1–2 of the build spec: **the importer and the local library**. No cloud
account, no server. It pages your X bookmarks in your own browser, writes
every raw payload to disk, and normalizes them into a local SQLite file with
FTS5 already indexed.

```
apps/cli/        the importer, adapters, ingest receiver
apps/web/        TanStack Start on Workers: the JSON API and /mcp
packages/db/     schema, migrations, the driver-taking db module
packages/mcp/    the four tools, transport-agnostic
packages/infra/  D1 + R2 + the Worker, as Alchemy resources
packages/env/    the Worker's bindings, typed from infra
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
| `anansi import github` | your starred repos, with a real `starred_at` |
| `anansi media sync` | fetch thumbnails; `--r2` uploads instead of `data/media/` |
| `anansi serve --mcp` | the four MCP tools over stdio, for your agent |
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

**CJK is tokenized badly, but it matters less than it looks.** `unicode61`
splits on non-alphanumeric characters and Japanese has no spaces, so a whole
run becomes one token — `デザイン` returns 0 hits against a post that plainly
contains it. `scripts/probe-cjk.ts` measures it.

The corpus makes this small, though: 36 items contain CJK, and 34 of them also
carry a Latin word of four characters or more (`GitHub`, `Codex`, a URL), which
is enough to find them. **Two items** are genuinely unreachable. Not worth a
second index.

What is missing is fuzziness, not tokenization. A misspelling returns nothing,
because BM25 has no notion of near. `search_memory` says so in its description
so the agent retries rather than concluding the library is empty.

## The MCP server

Four tools, reading the same database through the same functions the HTTP
routes will call — registered against a server rather than wired to a
transport, so the same four run over stdio today and over HTTP from a Worker
later. There is no second implementation to drift.

```
search_memory(query, source?, author?, since?, limit)
get_item(id)
recent_saves(source?, limit)
find_by_author(handle, limit)
```

To use it from any project, once:

```bash
claude mcp add anansi --scope user -- bun run <path to anansi>/apps/cli/src/cli.ts serve --mcp
```

Inside this repo, `.mcp.json` already does it.

Two rules the tools enforce. **Excerpts, never full bodies** — capped at 300
characters, because ten full posts with their payloads would spend an agent's
context on `__typename` fields. And **every result carries its url**, because
an unattributed memory is a hallucination waiting to happen.

`get_item` deliberately does not return `raw`, though the spec's sketch lists
it. Everything raw is actually consulted for — links, thread siblings, media —
is extracted instead. `apps/cli/scripts/mcp-smoke.ts` drives the whole thing
over real stdio and fails if any of that regresses.

### GitHub, and what it proved

Adding a second source touched **no file** in `core/`, `packages/db`,
`packages/mcp` or `store/` — only a parser, a client, an adapter and one line
of dispatch. That is what the `CaptureAdapter` seam was for, and it is the
reason GitHub is second rather than tenth.

It is a genuine contrast with X. A documented endpoint, real pagination
(`Link: rel="next"`, with page number carried in the same `cursor` field the X
adapter fills with an opaque string), and `Accept:
application/vnd.github.star+json`, which is the whole reason to bother early:
without it you get a bare repo list, with it every entry carries `starred_at`.
**That is the first exact saved-at in the library**, and currently the only
thing exercising `saved_at_exact`.

`GITHUB_TOKEN` in `.env` is fine to ask for, unlike the X cookies: a
fine-grained PAT is purpose-scoped, read-only, revocable from a settings page,
and carries no session.

One honest limit. Cross-source recency is approximate until X can produce real
timestamps — backfilled X items are stamped with import time, so they outrank
stars you added months ago. Within a source the ordering is correct, and
`recent_saves(source: "github")` is exact.

### Media

`anansi media sync` fetches a thumbnail for every media row that has none.
Local by default, `--r2` to upload; one `MediaSink` interface, the same driver
seam the database uses.

The spec says "fetch and convert locally". There is nothing to convert —
`pbs.twimg.com` does it:

```
original                 75.5 KB  image/jpeg
?format=webp&name=small  18.9 KB  image/webp
```

So no `sharp`, no native module, no local CPU, and nothing in this path that
could not also run inside a Worker. The fetch *is* the conversion.

Measured on the real library: **1,246 thumbnails, 31.6 MB, zero failures, 101
seconds.** The spec estimated 150-200 MB for fewer items; the real figure is
about a fifth of that, and 0.3% of R2's 10 GB free tier.

Video is stored as its poster frame and never as the MP4 — that is the one
line in the cost section that could actually start a bill.

`stored_key` survives a reparse. Media rows are replaced wholesale on import,
which is right for staleness, but a fresh uuid each time would orphan every
uploaded file and re-download the library; identity and upload state are
carried across on `(item_id, origin_url)`.

The R2 path is wired but **unverified against a live bucket** — that needs a
Cloudflare account, which days 1-7 deliberately do not require.

### The edge

Generated with Better-T-Stack and merged, rather than hand-rolled:

```bash
bun create better-t-stack@latest anansi-web   --frontend tanstack-start --backend self --runtime none   --database sqlite --orm drizzle --db-setup d1   --api none --auth none --addons none --examples none   --web-deploy cloudflare --package-manager bun
```

Two flags were found by running it rather than reading about it.
`--backend self` means the fullstack framework hosts its own backend and
**requires `--runtime none`** — it produces `apps/web` and no `apps/server`,
which is what the "MCP tools call the same functions the HTTP routes call"
rule wants. And `--database sqlite` alone means *Turso*; `--db-setup d1` is
what actually produces `drizzle-orm/d1` and a `Cloudflare.D1.Database`.

The API is a plain `Request -> Response` function with the TanStack route as a
three-line wrapper, so it is tested against the real library with no framework
in the way. `/mcp` uses the SDK's `WebStandardStreamableHTTPServerTransport` —
a Worker has `Request` and `Response`, not node req/res streams — and serves
the identical `createAnansiServer` the stdio CLI does.

Both `/api/ingest` and `/mcp` are **closed unless a token is configured**. An
open ingest on a public URL is an invitation to have someone else's library
merged into yours.

### Testing it before deploying

Vite's dev SSR runs under Node, which cannot load `bun:sqlite`, so the
TanStack dev server cannot reach the local library. That is a dev-runtime
limitation, not a problem with the code — `handleApi` and `handleMcp` are
plain `Request -> Response`, so they mount on Bun directly:

```bash
INGEST_TOKEN=dev-ingest MCP_TOKEN=dev-mcp bun run apps/web/scripts/serve-local.ts
bun run apps/web/scripts/mcp-http-smoke.ts
```

Verified locally against the real 1,274-item library: every read endpoint,
keyset pagination with no overlap between pages, bearer auth on ingest
(401 without, 401 wrong, idempotent with), and the full MCP handshake over
HTTP — `initialize`, `tools/list`, `search_memory`, `get_item` — using the
same `createAnansiServer` the stdio CLI calls. The FTS index and all 1,246
`stored_key`s survive an HTTP ingest.

**What is still untested:** the three-line TanStack route wrapper and the D1
binding. Those are the only two layers a deploy would exercise for the first
time.

**Not yet deployed.** `bun run deploy` needs a Cloudflare account, which
nothing before this point required.

### The interface

Two views, not four — Library and Creators. Search is an **overlay** and item
detail is a **drawer**, because both are things you do *to* the library rather
than places you go instead of it; opening a result should never cost you your
scroll position or your query.

The palette is the product surface, per the Screens canvas note. It debounces
and aborts in flight, shows the real bm25 score (negative, lower is better)
because that is the first thing that explains a wrong-looking result, and its
empty state says what is actually wrong — keyword search has no notion of
near, so a misspelling returns nothing.

Grid pagination is keyset and infinite. Offset paging would silently drop or
repeat items whenever an import ran underneath a scroll, which is a thing that
will happen.

Colours and type come straight from the Screens artboards rather than being
reinterpreted, so a screenshot of the app and a screenshot of the mockup are
the same design. Creators reproduces its numbers off the real library: 874
authors, 1.46 saves per author, 695 saved exactly once.

To run it, both halves:

```bash
INGEST_TOKEN=dev-ingest MCP_TOKEN=dev-mcp bun run apps/web/scripts/serve-local.ts
bun run dev:web    # with VITE_API_BASE=http://127.0.0.1:8788 in apps/web/.env.local
```

## What is deliberately not here yet

The extension (day 13).

## Terms

Automated access to X outside the official API is against their developer
terms. Every request this tool makes is made from your machine, with your own
session, against your own account. That is not the same as being in the clear.
