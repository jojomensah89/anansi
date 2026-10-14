# Historical Alchemy Cloudflare acceptance runbook

> **Superseded. Do not run the commands from the old procedure.** This packet
> described the former `packages/infra` Alchemy development stack, which is no
> longer the current deployment path. It is retained at this path because older
> architecture notes link to it.

Use the current repository workflows instead:

- [Local AI search and tagging](../../../README.md#developer-only-local-ai-search-and-tagging)
  documents the local SQLite and Ollama path.
- [Cloudflare deployment](../../../README.md#b-cloudflare--one-click-self-hosting)
  and [hosted semantic search](../../../README.md#hosted-semantic-search)
  describe the current Wrangler bindings and hosted behavior.
- [Existing Alchemy installations](../../../README.md#existing-alchemy-installations)
  documents the one-time handoff of existing resources to Wrangler.
- [Manual deploy and local development](../../../README.md#manual-deploy-and-local-development)
  documents `bun run cf-typegen`, `bun run build`, and `bun run deploy`.

The local Ollama smoke checks do not validate hosted Workers AI, Vectorize,
Cloudflare scheduling, or clean-account deployment. A hosted acceptance
procedure must be written against the Wrangler workflow before claiming those
checks have passed.
