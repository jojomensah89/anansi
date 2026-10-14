import { describe, expect, test } from "bun:test";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { handleRestoreRequest } from "./restore.ts";

const origin = "http://localhost:3000";
const backupId = "a".repeat(64);
const counts = { items: 0, tags: 0, itemTags: 0, itemTagOverrides: 0, itemSourceLinks: 0, highlights: 0, media: 0, collections: 0 };

function request(path: string, method = "POST", body?: unknown, auth = true) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { ...(auth ? { authorization: "Bearer secret" } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("restore HTTP handler", () => {
  test("requires library authorization and reports a resumable state", async () => {
    const env = { db: openTestDb(), libraryToken: "secret" };
    expect((await handleRestoreRequest(env, request("/api/restore", "GET", undefined, false))).status).toBe(401);
    const started = await handleRestoreRequest(env, request("/api/restore/start", "POST", { backupId, counts }));
    expect(started.status).toBe(200);
    expect((await started.json() as { restore: { progress: { items: number } } }).restore.progress.items).toBe(0);
    const status = await handleRestoreRequest(env, request("/api/restore", "GET"));
    expect((await status.json() as { restore: { backupId: string } }).restore.backupId).toBe(backupId);
    const finished = await handleRestoreRequest(env, request("/api/restore/finish", "POST", { backupId }));
    expect((await finished.json() as { restore: { status: string } }).restore.status).toBe("complete");
  });

  test("rejects oversized JSON before parsing", async () => {
    const env = { db: openTestDb(), libraryToken: "secret" };
    const response = await handleRestoreRequest(env, request("/api/restore/start", "POST", { filler: "x".repeat(2 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  });

  test("abort requires auth and resets an unstarted restore", async () => {
    const env = { db: openTestDb(), libraryToken: "secret" };
    await handleRestoreRequest(env, request("/api/restore/start", "POST", { backupId, counts }));
    expect((await handleRestoreRequest(env, request("/api/restore/abort", "POST", { backupId }, false))).status).toBe(401);
    const aborted = await handleRestoreRequest(env, request("/api/restore/abort", "POST", { backupId }));
    expect(aborted.status).toBe(200);
    expect((await aborted.json() as { aborted: boolean }).aborted).toBe(true);
  });
});
