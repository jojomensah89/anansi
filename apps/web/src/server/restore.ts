import {
  abortLibraryRestore, finishLibraryRestore, getLibraryRestore, RESTORE_TABLES,
  startLibraryRestore, writeLibraryRestoreChunk,
  type AnansiDb, type RestoreCounts, type RestoreTable,
} from "@anansi/db";
import { authorizeLibrary, type LibraryAuthEnv } from "./library-auth.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
type RestoreEnv = LibraryAuthEnv & { db: AnansiDb };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });

async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new Error("request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("request too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("invalid JSON"); }
}

/** The dispatcher calls this for /api/restore and /api/restore/{start,chunk,finish,abort}. */
export async function handleRestoreRequest(env: RestoreEnv, request: Request): Promise<Response> {
  const denied = authorizeLibrary(env, request);
  if (denied) return denied;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  try {
    if (path === "/api/restore" && request.method === "GET") return json({ restore: await getLibraryRestore(env.db) });
    if (path === "/api/restore/start" && request.method === "POST") {
      const body = await boundedJson(request) as { backupId?: unknown; counts?: unknown } | null;
      if (!body || typeof body.backupId !== "string" || !body.counts || typeof body.counts !== "object") throw new Error("invalid restore request");
      return json({ restore: await startLibraryRestore(env.db, body.backupId, body.counts as RestoreCounts) });
    }
    if (path === "/api/restore/chunk" && request.method === "POST") {
      const body = await boundedJson(request) as { backupId?: unknown; table?: unknown; offset?: unknown; rows?: unknown } | null;
      if (!body || typeof body.backupId !== "string" || typeof body.table !== "string" || !RESTORE_TABLES.includes(body.table as RestoreTable) || typeof body.offset !== "number" || !Array.isArray(body.rows)) throw new Error("invalid restore request");
      return json({ restore: await writeLibraryRestoreChunk(env.db, { backupId: body.backupId, table: body.table as RestoreTable, offset: body.offset, rows: body.rows }) });
    }
    if (path === "/api/restore/finish" && request.method === "POST") {
      const body = await boundedJson(request) as { backupId?: unknown } | null;
      if (!body || typeof body.backupId !== "string") throw new Error("invalid restore request");
      return json({ restore: await finishLibraryRestore(env.db, body.backupId) });
    }
    if (path === "/api/restore/abort" && request.method === "POST") {
      const body = await boundedJson(request) as { backupId?: unknown } | null;
      if (!body || typeof body.backupId !== "string") throw new Error("invalid restore request");
      await abortLibraryRestore(env.db, body.backupId);
      return json({ aborted: true });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed";
    if (message === "request too large") return json({ error: message }, 413);
    if (/already|empty library|conflicts|order|incomplete|No active restore|No restore|abandoned|abort is unavailable/.test(message)) return json({ error: message }, 409);
    if (/^Invalid |^invalid |Unsupported/.test(message)) return json({ error: message }, 400);
    return json({ error: "Restore failed" }, 500);
  }
}
