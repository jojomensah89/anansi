import { markMediaStored, mediaStats, pendingMedia } from "@anansi/db";
import type { AnansiDb, PendingMedia } from "@anansi/db";
import type { MediaSink } from "./sink.ts";

/**
 * Fetch pending media and store it.
 *
 * The spec says "fetch and convert locally". It turns out there is nothing to
 * convert: pbs.twimg.com serves the conversion itself.
 *
 *   original                75.5 KB  image/jpeg
 *   ?format=webp&name=small 18.9 KB  image/webp
 *
 * So no sharp, no native module, no local CPU, and — the part that matters
 * later — nothing here that could not also run inside a Worker. The fetch IS
 * the conversion.
 *
 * Video is stored as its poster frame and never as the MP4. That is the one
 * line in the cost section that could actually start a bill: a hundred MP4s
 * is one to two gigabytes against R2's 10 GB free tier, where posters are
 * single-digit kilobytes.
 */

export type MediaSize = "thumb" | "small" | "medium" | "large";

export interface SyncOptions {
  sink: MediaSink;
  size?: MediaSize;
  limit?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SyncResult {
  attempted: number;
  stored: number;
  skipped: number;
  failed: { url: string; reason: string }[];
  bytes: number;
  durationMs: number;
  total: number;
  storedOverall: number;
}

/** Every media url in this library is on pbs.twimg.com, which takes these. */
function variant(originUrl: string, size: MediaSize): string {
  try {
    const url = new URL(originUrl);
    if (!url.hostname.endsWith("twimg.com")) return originUrl;
    // The extension is carried by the format parameter, not the path.
    url.pathname = url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, "");
    url.searchParams.set("format", "webp");
    url.searchParams.set("name", size);
    return url.toString();
  } catch {
    return originUrl;
  }
}

function keyFor(row: PendingMedia): string {
  // Sharded two levels so no directory holds thousands of entries, and so the
  // same layout is sane as an R2 prefix.
  const id = row.id.replace(/-/g, "");
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.webp`;
}

export async function syncMedia(db: AnansiDb, opts: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const size = opts.size ?? "small";
  const concurrency = opts.concurrency ?? 8;

  const rows = await pendingMedia(db, opts.limit);
  const result: SyncResult = {
    attempted: rows.length,
    stored: 0,
    skipped: 0,
    failed: [],
    bytes: 0,
    durationMs: 0,
    total: 0,
    storedOverall: 0,
  };

  let cursor = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const row = rows[cursor++];
      if (!row) return;
      const key = keyFor(row);

      try {
        // A file already present means an interrupted run, not a fresh one:
        // record it and move on rather than paying for the fetch again.
        if (await opts.sink.has(key)) {
          await markMediaStored(db, row.id, key);
          result.skipped++;
        } else {
          const res = await fetch(variant(row.originUrl, size));
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const bytes = await res.arrayBuffer();
          const type = res.headers.get("content-type") ?? "image/webp";
          await opts.sink.put(key, bytes, type);
          await markMediaStored(db, row.id, key);
          result.stored++;
          result.bytes += bytes.byteLength;
        }
      } catch (err) {
        // A dead thumbnail is normal — posts get deleted, accounts go private.
        // It must never take the run down with it.
        result.failed.push({ url: row.originUrl, reason: (err as Error).message });
      }

      opts.onProgress?.(++done, rows.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  const stats = await mediaStats(db);
  result.total = stats.total;
  result.storedOverall = stats.stored;
  result.durationMs = Date.now() - started;
  return result;
}
