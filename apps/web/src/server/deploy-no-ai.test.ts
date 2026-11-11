import { expect, test } from "bun:test";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { setAiSettings, restoreCounts, RESTORE_TABLES } from "@anansi/db";
import { handleApi } from "./api.ts";
import { runAiJobs } from "./ai-schedule.ts";

const unavailable = async (): Promise<never> => { throw new Error("unprovisioned"); };

test("AI off never invokes unprovisioned providers; absent bindings preserve scheduled work", async () => {
  const db = openTestDb();
  let calls = 0;
  const ai = { run: async () => { calls++; return unavailable(); } };
  const vectorize = { upsert: unavailable, query: unavailable, deleteByIds: unavailable };
  await runAiJobs(db, { AI: ai, VECTORIZE: vectorize });
  expect(calls).toBe(0);
  await setAiSettings(db, { semanticSearchEnabled: true, autoTaggingEnabled: true });
  await runAiJobs(db, {});
  await runAiJobs(db, { VECTORIZE: vectorize });
});

test("no AI bindings: capture, library, keyword fallback, export and HTTP restore", async () => {
  const db = openTestDb();
  const env = { db, libraryToken: "secret", ingestToken: "secret" };
  const call = (path: string, body?: unknown, target = env) => handleApi(target, new Request("https://anansi.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const item = { source: "web", externalId: "no-ai", url: "https://example.com/no-ai", kind: "article", body: "optional deployment bindings", savedAt: 1788390100, savedAtIsExact: true, metrics: {}, media: [], links: [], raw: {} };
  expect((await call("/api/ingest", { items: [item] })).status).toBe(200);
  expect((await call("/api/items")).status).toBe(200);
  await setAiSettings(db, { semanticSearchEnabled: true });
  const search = await (await call("/api/search?q=optional")).json() as any;
  expect(search.items).toHaveLength(1);
  expect(search.semantic.applied).toBe(false);
  for (const bindings of [{ ai: { run: unavailable } }, { vectorize: { upsert: unavailable, query: unavailable } }, { ai: { run: unavailable }, vectorize: { upsert: unavailable, query: unavailable } }]) {
    const response = await handleApi({ ...env, ...bindings }, new Request("https://anansi.test/api/search?q=optional", { headers: { authorization: "Bearer secret" } }));
    expect(response.status).toBe(200);
    expect((await response.json() as any).items).toHaveLength(1);
  }
  const backup = await (await call("/api/export")).json() as any;
  const restored = { ...env, db: openTestDb() };
  const backupId = "b".repeat(64);
  expect((await call("/api/restore/start", { backupId, counts: restoreCounts(backup) }, restored)).status).toBe(200);
  for (const table of RESTORE_TABLES) {
    const rows = backup[table] ?? [];
    if (rows.length) expect((await call("/api/restore/chunk", { backupId, table, offset: 0, rows }, restored)).status).toBe(200);
  }
  expect((await call("/api/restore/finish", { backupId }, restored)).status).toBe(200);
  expect((await (await call("/api/search?q=optional", undefined, restored)).json() as any).items).toHaveLength(1);
});
