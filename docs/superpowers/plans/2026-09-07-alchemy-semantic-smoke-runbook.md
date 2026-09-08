# Alchemy Cloudflare acceptance runbook

This is an opt-in developer check for the hosted adapters. It is not part of
normal tests, local SQLite development, CI, or the hosted user's setup.

## What it proves

`alchemy dev` runs the Worker locally while the `AI` and `VECTORIZE` bindings
in `packages/infra/alchemy.run.ts` use Cloudflare services for the named
development stage. The check exercises the hosted model/index contract, D1
hydration, authentication, AI tagging, semantic API search, and HTTP MCP
transport. It does not prove a clean-account production deployment or an
authenticated X/Reddit/GitHub provider import.

MCP remains keyword/BM25 in this run. The web UI's local Ollama semantic path
is a separate local-only capability.

## Safety boundary

- Use a unique stage and its isolated D1, R2, and Vectorize resources.
- Use synthetic items only; never point this check at a production stage.
- Keep `LIBRARY_TOKEN`, `INGEST_TOKEN`, and `MCP_TOKEN` in the local env or
  Alchemy profile. Do not print them, paste them into committed files, or put
  them in a URL.
- Remote AI calls consume account quota. Run only when you explicitly accept
  that cost.
- Record the stage name and URL privately so teardown targets exactly that
  stage.

## Procedure

From `packages/infra`, choose a unique stage and start the local Worker:

```powershell
$stage = "anansi-acceptance-$env:USERNAME-$(Get-Date -Format yyyyMMddHHmmss)"
bun run prepare:migrations
bunx alchemy dev --stage $stage
```

If the Alchemy profile is not configured, stop and run
`bunx alchemy login --configure` first. Record the URL printed by Alchemy as
`$url` in a second terminal. Keep the dev process running during the checks.

With the configured bearer secrets available through your local environment,
run the following sequence against `$url`:

1. `PATCH /api/ai` with `{ "semanticSearchEnabled": true, "autoTaggingEnabled": true }`.
2. `POST /api/ingest` a small synthetic `web` item with a unique
   `eventId` and matching `Idempotency-Key`.
3. Poll `GET /api/ai` until the tagging and embedding jobs report completion.
   A scheduled Worker run may take a few minutes; do not send a burst of
   requests to force it.
4. `GET /api/items/<id>` and record that AI tags are present with AI
   provenance in the backing D1 data.
5. `GET /api/search?q=<exact terms>` and record the BM25 result. Then query a
   differently worded concept and record `semantic.applied`, the result IDs,
   and the hosted model/index response.
6. Send MCP JSON-RPC requests to `$url/mcp`: `initialize`, `tools/list`, and
   `tools/call` for `search_memory` and `get_item`. Verify bearer rejection
   with a wrong token and verify the returned item URL. Do not expect MCP to
   perform semantic ranking.
7. Replay the same ingest event and verify the original receipt/item ID is
   returned without creating a second item.

The synthetic record is intentionally left in the isolated stage until the
checks finish. Anansi preserves items rather than deleting them through a
public API, so stage teardown is the cleanup boundary for this acceptance run.

## Teardown

Stop the local Worker, then destroy only the named development stage:

```powershell
bunx alchemy destroy --stage $stage
```

If the command fails, do not substitute a broad cleanup. Re-run it with the
exact recorded stage after checking Alchemy's state output.

## Evidence boundary

Record hosted results separately from `bun run e2e:local`,
`bun run semantic:ollama`, and `bun run ai:tagging:ollama`. Local checks prove
the local runtime and transport contracts; this runbook proves a named
Cloudflare development stage; neither alone establishes clean-account deploy,
production quota capacity, or authenticated provider capture.
