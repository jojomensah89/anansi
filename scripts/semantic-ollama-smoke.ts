import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalSemanticCache } from "../apps/web/src/server/local-semantic-cache.ts";
import { createOllamaEmbeddingProvider } from "../apps/web/src/server/ollama-embedding.ts";
import { hybridSearch } from "../apps/web/src/server/semantic-search.ts";
import {
	type AnansiDb,
	items,
	searchItemsPage,
	semanticText,
	setAiSettings,
	upsertItems,
} from "../packages/db/src/index.ts";
import { migrateLocalDb, openLocalDb } from "../packages/db/src/local.ts";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: this explicit smoke command is outside the Turbo task graph.
const model = process.env.OLLAMA_EMBEDDING_MODEL ?? "embeddinggemma";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this explicit smoke command is outside the Turbo task graph.
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const temp = mkdtempSync(join(tmpdir(), "anansi-ollama-smoke-"));
const cache = openLocalSemanticCache(join(temp, "semantic.sqlite"), model);

try {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	const db = local as unknown as AnansiDb;
	await upsertItems(db, [
		{
			source: "web",
			externalId: "semantic-target",
			url: "https://example.com/semantic-target",
			kind: "article",
			title: "Nearest-neighbour retrieval",
			body: "A guide to vector indexes that find similar documents by meaning.",
			savedAt: 100,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		},
		{
			source: "web",
			externalId: "lexical-distractor",
			url: "https://example.com/lexical-distractor",
			kind: "article",
			title: "Garden notes",
			body: "How to keep herbs alive on a sunny balcony.",
			savedAt: 99,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		},
		{
			source: "web",
			externalId: "second-distractor",
			url: "https://example.com/second-distractor",
			kind: "article",
			title: "Coffee recipes",
			body: "A simple guide to brewing coffee at home.",
			savedAt: 98,
			savedAtIsExact: true,
			metrics: {},
			media: [],
			links: [],
			raw: {},
		},
	]);
	await setAiSettings(db, { semanticSearchEnabled: true });

	const provider = createOllamaEmbeddingProvider({ model, baseUrl });
	const rows = await db.select().from(items);
	const vectors = [];
	for (const item of rows)
		vectors.push({
			id: item.id,
			contentHash: item.id,
			values: await provider.embed(semanticText(item)),
		});
	await cache.upsertRecords(vectors);
	cache.setStatus({
		state: "ready",
		indexed: vectors.length,
		pending: 0,
		dimension: provider.dimensions,
	});

	const query = "finding similar documents by meaning";
	const lexical = await searchItemsPage(db, { query, limit: 10 });
	const result = await hybridSearch(
		db,
		query,
		{ limit: 10 },
		lexical,
		{ enabled: true },
		{ provider, index: cache, status: () => cache.snapshot() },
	);
	const target = rows.find((item) => item.externalId === "semantic-target");
	const found = target
		? result.items.some((item) => item.id === target.id)
		: false;
	console.log(
		JSON.stringify(
			{
				model: provider.model,
				dimensions: provider.dimensions,
				indexed: vectors.length,
				bm25Count: lexical.items.length,
				semanticCount: result.items.length,
				results: result.items.map((item) => ({
					id: item.id,
					title: item.title,
				})),
				semantic: result.semantic,
				expectedSemanticOnlyMatch: found,
			},
			null,
			2,
		),
	);
	if (!found) throw new Error("required semantic-only match was not retrieved");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	cache.close();
	rmSync(temp, { recursive: true, force: true });
}
