# ADR 0005: Semantic agent search and optional client writes

- Status: Accepted
- Date: 2026-11-09
- Supersedes: ADR 0004

HTTP and MCP use the same search coordinator and hybrid retrieval module. Hosted embeddings debit the existing shared monthly budget once before inference. AI off, missing runtime, exhausted budget, provider errors/timeouts, empty index and keyword cursor continuation return keyword results. MCP adds search_mode and fallback_reason without removing fields. Freshness and offline sync metadata remain independent of retrieval mode. Embedding and vector queries each have a five-second deadline; underlying provider promises may finish afterwards.

Connected clients remain read-only by default. The existing scopes text stores read or read,write for API and app clients. Only a same-origin owner session can toggle write through PATCH /api/clients/:id/permissions. OAuth consent still requests library:read. Write is a subsequent owner grant on the connected app, rather than an app-requested scope: this gives the owner one consistent control for API keys and apps without requiring token reissue. It also means the owner's grant affects existing tokens. Revocation and scope removal apply on the next request.

Write-enabled clients see add_tag, remove_tag, set_note (empty clears) and save_link. Saves use canonical web identity and the existing ingest and preview path. There is no delete tool. Legacy tokens and local stdio remain read-only. The package accepts search and write adapters; storage, budget and authorization stay on the server.

Migration 0025 is needed for an existing nested note/FTS trigger defect exposed by set/clear tests, not for scope storage. Restricting the FTS trigger to indexed columns prevents duplicate index deletes when the note trigger updates search_text. Rebuild repairs previously affected indexes.
