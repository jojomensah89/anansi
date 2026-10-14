import type { RestoreTable } from "@anansi/db";
import { validateRestoreBackup } from "@anansi/db/restore-preflight";
import { api } from "./api.ts";

const TABLES = ["items", "tags", "itemTags", "itemTagOverrides", "itemSourceLinks", "highlights", "media", "collections"] as const satisfies readonly RestoreTable[];
const MAX_FILE_BYTES = 100_000_000;
const MAX_CHUNK_BYTES = 1_500_000;

export async function restoreLibraryFile(file: File, onProgress: (message: string) => void): Promise<void> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Export exceeds the 100 MB browser restore limit.");
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const backupId = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("This file is not valid JSON."); }
  const { backup, counts } = validateRestoreBackup(value);
  let { restore } = await api.restoreStart(backupId, counts);
  if (restore.status === "complete") { onProgress("This export was already restored."); return; }
  const total = TABLES.reduce((sum, table) => sum + counts[table], 0);
  for (const table of TABLES) {
    const rows = backup[table] ?? [];
    while (restore.progress[table] < rows.length) {
      const offset = restore.progress[table];
      let count = 0;
      let size = 0;
      for (let i = offset; i < rows.length && count < 30; i++) {
        const rowSize = new TextEncoder().encode(JSON.stringify(rows[i])).byteLength;
        if (rowSize > MAX_CHUNK_BYTES) throw new Error(`${table} row ${i + 1} is too large for browser restore.`);
        if (count > 0 && size + rowSize > MAX_CHUNK_BYTES) break;
        count++;
        size += rowSize;
      }
      ({ restore } = await api.restoreChunk(backupId, table, offset, rows.slice(offset, offset + count)));
      const done = TABLES.reduce((sum, name) => sum + restore.progress[name], 0);
      onProgress(`Restored ${done.toLocaleString()} of ${total.toLocaleString()} records…`);
    }
  }
  await api.restoreFinish(backupId);
  onProgress("Library data restored. Media files will need to be fetched again.");
}
