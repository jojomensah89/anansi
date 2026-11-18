# Cloudflare deployment verification

## Current status

**Deployment verified by the project owner.** Jojo confirmed on 2026-11-18
that they have verified Anansi deployment. This owner confirmation supersedes
the earlier pending status and is recorded as complete in the README.

## Detailed regression checklist

The checklist below is retained for future runs. Its individual results and
timing measurements have not been recorded here; unchecked boxes do not change
the owner-verified deployment status.

For a timed fresh-account run, target under 10 minutes from clicking the
button to the first captured save visible in the hosted library. Record click,
deploy and first-capture timestamps, total elapsed time and any failures.

- [ ] Use a brand-new Cloudflare account and a public repository containing this
  change. Click Deploy to Cloudflare; keep the repository root and default names.
  Enter ANANSI_SECRET, Vectorize dimensions 384 and metric cosine. Record any
  extra prompts, R2 activation or billing requirements and their elapsed time.
- [ ] Accept detected bun run build / bun run deploy. Verify Bun 1.4.2 is selected
  without a BUN_VERSION override. Confirm pending SQL migrations apply before
  publication. No drizzle-kit generate is needed.
- [ ] Open the hosted URL, sign in with ANANSI_SECRET and confirm an empty library
  with both AI features off and no Worker errors.
- [ ] Install the public Chrome extension or verified public unpacked artifact.
  Connect with the Worker URL and secret. Save a web page; confirm it appears
  in the library. Stop the first-capture timer here; require under 10 minutes.
- [ ] Search a phrase from the capture with AI off; confirm keyword results.
  Export JSON in Settings and retain the backup outside the deployment.
- [ ] Restore into an empty disposable library using Settings. Compare counts,
  capture text and keyword search. Retain archived media separately: JSON does
  not contain media bytes.
- [ ] Connect one OAuth-capable MCP agent to the hosted /mcp endpoint, complete
  owner consent and call search_saved. Record agent/version and scopes; confirm
  the capture is returned, then revoke the client.
- [ ] On a disposable deployment repeat library, capture, search, export and
  restore with AI and VECTORIZE absent, then with each individually absent.
  With semantic search previously enabled, simulate provider/index unavailability
  and confirm keyword fallback. With AI off, check scheduled calls have no errors.
  Vector deletion work may wait for the index to return.
- [ ] Trigger another repository build; confirm migrations are idempotent and
  captures survive. Confirm public extension CI/artifact checks remain intact.

## Sources checked 2026-11-11

- [Deploy button](https://developers.cloudflare.com/workers/platform/deploy-buttons/):
  auto-provisioning, package-script detection and migrations by binding name.
- [Wrangler Vectorize bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#vectorize-indexes):
  no dimensions or metric fields; retain the two index creation prompts.
- [Vectorize creation](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/):
  dimensions and metric are creation options, not binding properties.
- [Workers Builds image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/):
  root packageManager selects the exact Bun version. No .bun-version or engines
  workaround is needed.

For future detailed runs, record exact dashboard prompts, provisioning, live
OAuth and timing results against the checklist above. Automated tests/builds
alone do not establish these outcomes; the deployment status above is based
on owner confirmation.
