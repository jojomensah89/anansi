import { env as transformersEnv, pipeline } from "@huggingface/transformers";
import { tmpdir } from "node:os";
import { listItems, searchItemsPage, upsertItems, type AnansiDb, type SearchOptions } from "../packages/db/src/index.ts";
import { migrateLocalDb, openLocalDb } from "../packages/db/src/local.ts";
import { validateVector, type EmbeddingProvider } from "../apps/web/src/server/ai.ts";
import { LocalVectorIndex } from "../apps/web/src/server/local-vector-index.ts";
import { hybridSearch } from "../apps/web/src/server/semantic-search.ts";

const MODEL = process.env.ANANSI_LOCAL_MODEL ?? "Xenova/bge-small-en-v1.5";
const DIMENSIONS = 384;
const CACHE = process.env.ANANSI_TRANSFORMERS_CACHE ?? `${tmpdir()}/anansi-transformers-cache`;

transformersEnv.cacheDir = CACHE;
transformersEnv.allowRemoteModels = true;
transformersEnv.allowLocalModels = true;
transformersEnv.logLevel = 40;

async function localProvider(): Promise<EmbeddingProvider> {
  const extractor = await pipeline("feature-extraction", MODEL);
  return {
    model: MODEL,
    dimensions: DIMENSIONS,
    embed: async (text) => {
      const output = await extractor(text.slice(0, 12_000), { pooling: "mean", normalize: true });
      return validateVector(Array.from(output.data), DIMENSIONS);
    },
  };
}

const options: SearchOptions = {
  query: "looking for conceptually similar material",
  source: [],
  author: [],
  tag: [],
  contentType: [],
  archived: false,
  removed: "include",
  order: "saved",
  limit: 3,
};

async function main() {
  const started = performance.now();
  const localDb = openLocalDb(":memory:");
  migrateLocalDb(localDb);
  const db = localDb as unknown as AnansiDb;
  const corpus = [
    {
      source: "web", externalId: "semantic-neighbors", url: "https://example.test/semantic-neighbors",
      kind: "article", body: "Nearest-neighbor vector indexes retrieve related notes by meaning rather than exact words.",
    },
    {
      source: "web", externalId: "lexical-distractor", url: "https://example.test/bread",
      kind: "article", body: "A practical guide to baking bread with a hot oven and sourdough starter.",
    },
    {
      source: "web", externalId: "travel-distractor", url: "https://example.test/travel",
      kind: "article", body: "A weekend itinerary for museums, markets, and public transport.",
    },
    {
      source: "web", externalId: "exact-distractor", url: "https://example.test/material",
      kind: "article", body: "A materials catalogue with similar fabric samples and colour swatches.",
    },
  ].map((item, index) => ({
    ...item,
    savedAt: 1_788_390_000 + index,
    savedAtIsExact: true,
    metrics: {}, media: [], links: [], raw: {},
  }));
  await upsertItems(db, corpus);
  const all = await listItems(db, { limit: 20 });
  const expected = all.items.find((item) => item.url.endsWith("/semantic-neighbors"));
  if (!expected) throw new Error("semantic fixture was not persisted");

  const provider = await localProvider();
  const index = new LocalVectorIndex(DIMENSIONS);
  for (const item of all.items) await index.upsert([{ id: item.id, values: await provider.embed(item.excerpt) }]);
  const lexical = await searchItemsPage(db, options);
  const hybrid = await hybridSearch(db, options.query, options, lexical, { enabled: true, dimensions: DIMENSIONS }, provider, index);
  const lexicalIds = lexical.items.map((item) => item.id);
  const hybridIds = hybrid.items.map((item) => item.id);
  const report = {
    model: MODEL,
    dimensions: DIMENSIONS,
    corpusSize: corpus.length,
    lexicalIds,
    semanticIds: hybridIds,
    expectedId: expected.id,
    expectedWasLexical: lexicalIds.includes(expected.id),
    expectedWasSemantic: hybridIds.includes(expected.id),
    semantic: hybrid.semantic,
    durationMs: Math.round(performance.now() - started),
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.expectedWasLexical || !report.expectedWasSemantic || !report.semantic.applied) {
    throw new Error("required semantic-only match was not returned");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
