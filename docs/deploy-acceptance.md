# Fresh-account deploy acceptance

Owner-run proof, not yet performed. Target: under 10 minutes from clicking the
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

Exact dashboard prompts, provisioning, live OAuth and timing need this real
account check. Automated tests/builds do not establish these outcomes.
