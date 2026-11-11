import { expect, test } from "bun:test";
import { aiEnrichmentJobs, getAiSettings, upsertItems } from "@anansi/db";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { handleApi } from "./api.ts";
import { runAiJobs } from "./ai-schedule.ts";

test("enabling queues all 44 existing saves before cron, then cron publishes tags", async () => {
  const db = openTestDb();
  await upsertItems(db, Array.from({ length: 44 }, (_, i) => ({ source: "web", externalId: `backfill-${i}`, url: `https://example.com/${i}`, kind: "article", body: "Software development", savedAt: i + 1, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} })));
  expect((await getAiSettings(db)).autoTaggingEnabled).toBe(0);
  let calls = 0;
  const ai = { run: async () => { calls++; return { response: '["technology"]' }; } };
  const env = { db, libraryToken: "test", ai };
  const response = await handleApi(env, new Request("https://anansi.test/api/ai", { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ autoTaggingEnabled: true }) }));
  expect(response.status).toBe(200);
  expect((await db.select().from(aiEnrichmentJobs)).length).toBe(44);
  expect(calls).toBe(0);
  await runAiJobs(db, { AI: ai });
  expect(calls).toBeGreaterThan(0);
  expect((await db.select().from(aiEnrichmentJobs)).some(job => job.status === "complete")).toBe(true);
});

test("confirmed semantic enable queues existing saves without invoking providers", async () => {
  const db = openTestDb();
  await upsertItems(db, [{ source: "web", externalId: "semantic-enable", url: "https://example.com/semantic", kind: "article", body: "Index me", savedAt: 1, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} }]);
  const unavailable = async (): Promise<never> => { throw new Error("must not call providers on enable"); };
  const env = { db, libraryToken: "test", ai: { run: unavailable }, vectorize: { upsert: unavailable, query: unavailable } };
  const response = await handleApi(env, new Request("https://anansi.test/api/ai", { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ semanticSearchEnabled: true, confirmSemanticBackfill: true }) }));
  expect(response.status).toBe(200);
  expect(await db.select().from(aiEnrichmentJobs)).toMatchObject([{ kind: "embedding", status: "pending" }]);
});
