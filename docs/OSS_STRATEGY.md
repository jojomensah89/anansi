# Anansi as an open-source product

Anansi should be presented as a real, self-hosted product with an open-source core. Its clearest promise is: **your personal web memory, in your own Cloudflare account, searchable by you and your coding agent.** That position supports a personal brand better than treating the repository as a code sample, because people can install it, inspect the tradeoffs, report problems, and watch the product improve.

## Product boundary

The open-source edition should include the complete personal-use loop:

- browser capture and durable retry;
- the searchable library, highlights, notes, tags, favourites, collections, and export;
- the authenticated HTTP and MCP interfaces;
- local SQLite operation and single-user Cloudflare deployment;
- migrations, backup instructions, security notes, and a synthetic demo library.

Keep the core useful without an account controlled by the project author. A future paid product can sell convenience: managed hosting, guided migration, monitoring, team libraries, shared collections, and support. It should not remove portability or make a user's own data hard to export.

## Cloudflare free-tier shape

The intended hosted deployment uses one Worker application, one D1 database, and one R2 bucket. The browser extension performs platform-session capture and sends bounded records to the Worker. D1 stores searchable metadata and text; R2 stores accepted image copies. Durable retry state lives in D1 and is processed in small batches through request `waitUntil` work and scheduled recovery, so the base install does not require Queues or Durable Objects.

This is suitable for a personal library when usage stays within Cloudflare's current free allowances. It is not an unlimited-hosting promise. Before each release, verify the published limits and test the Worker CPU time with a representative import. In particular, keep writes below D1's bound-parameter and per-invocation query limits, cap media sizes, and expose failures instead of silently dropping work.

The hosted release is ready only when all of these gates pass:

1. D1 ingestion uses D1-compatible atomic batches; callback transactions used by local SQLite are not a valid hosted implementation.
2. The web library is closed until `LIBRARY_TOKEN` is configured, while extension ingest uses its separate `INGEST_TOKEN`.
3. Media downloads validate every destination and redirect, accept a small raster MIME allowlist, enforce a streaming byte limit, and retain retry state.
4. A clean-account installation, migration, first capture, search, export, and restore are exercised against Cloudflare rather than inferred from local tests.
5. The README states measured limits and known restrictions, including any media hosts that the Worker refuses.

## Personal-brand release plan

Treat each release as evidence of product engineering. Publish a short architecture note for a hard decision, a demo showing capture through retrieval, measured free-tier usage for a realistic library, and a changelog tied to user-visible outcomes. Good early topics are preserving rich captures during bookmark sync, making extension delivery truthful, protecting a single-user library, and designing reliable media work without a paid queue.

Use an OSI-approved permissive license if broad adoption and contributions are the goal; MIT already matches the package metadata, but the repository should include an actual `LICENSE` file before it is announced. Add `CONTRIBUTING.md`, a security policy, issue templates, a support boundary, and a roadmap only after the first clean install is reproducible.

The first public milestone should be narrow: local SQLite is stable, Cloudflare single-user hosting is verified, and the extension supports the sources labelled “supported.” Experimental sources should remain visibly experimental. A polished installation and dependable recovery will contribute more to the brand than adding another source before those foundations are proven.
