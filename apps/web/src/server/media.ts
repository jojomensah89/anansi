import { join, normalize } from "node:path";

/**
 * Serving stored thumbnails.
 *
 * The importer writes them through a MediaSink; this reads them back, and it
 * is deliberately a separate, smaller thing. Writing needs an S3 client and a
 * filesystem; reading in a Worker needs neither — the R2 *binding* is already
 * on `env` and takes a key directly.
 *
 * Everything is served from our own copy rather than hot-linked from the
 * platform. That is the point of storing them: a deleted post still renders,
 * and no request from your library tells X what you are looking at.
 */
export interface MediaSource {
  /** The R2 binding, in a Worker. */
  bucket?: { get(key: string): Promise<{ body: ReadableStream } | null> };
  /** The directory the CLI wrote to, locally. */
  dir?: string;
  /** Set when the sink can be written to as well as read. */
  put?: (key: string, bytes: ArrayBuffer) => Promise<void>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export async function readMedia(source: MediaSource, key: string): Promise<Response> {
  // Keys come from the database, but this is a URL path segment reaching a
  // filesystem — treat it as hostile regardless of where it should have come
  // from. Anything that escapes the media directory is not a key.
  const safe = normalize(key).replace(/\\/g, "/");
  if (safe.startsWith("..") || safe.includes("../") || safe.startsWith("/")) {
    return new Response("bad key", { status: 400 });
  }

  if (source.bucket) {
    const object = await source.bucket.get(safe);
    if (!object) return new Response("not found", { status: 404 });
    return new Response(object.body, {
      headers: { "content-type": "image/webp", "cache-control": IMMUTABLE },
    });
  }

  if (source.dir) {
    const file = Bun.file(join(source.dir, safe));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: { "content-type": "image/webp", "cache-control": IMMUTABLE },
    });
  }

  return new Response("media is not configured", { status: 503 });
}

import { markMediaStored, pendingMedia } from "@anansi/db";
import type { AnansiDb } from "@anansi/db";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Fetch thumbnails for media that has none.
 *
 * The CLI has always done this; the server had not, so anything arriving
 * through the extension kept a media row with a null stored_key and rendered
 * as text. A card with no picture for a video is not a smaller card, it is
 * the wrong card.
 *
 * Bounded and fire-and-forget: an ingest must not wait on image fetches, and
 * a burst of saves must not turn into an unbounded download.
 */
export async function fetchPendingMedia(
  db: AnansiDb,
  source: MediaSource,
  limit = 40,
): Promise<{ stored: number; failed: number }> {
  const rows = await pendingMedia(db, limit);
  let stored = 0;
  let failed = 0;

  const work = rows.map(async (row) => {
    try {
      const url = variant(row.originUrl);
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const bytes = await res.arrayBuffer();
      const key = keyFor(row.id);

      if (source.put) await source.put(key, bytes);
      else if (source.dir) {
        const path = `${source.dir}/${key}`;
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, bytes);
      } else throw new Error("no media sink");

      await markMediaStored(db, row.id, key);
      stored++;
    } catch {
      // A dead thumbnail is normal — posts get deleted, accounts go private.
      // It must never take an ingest down with it.
      failed++;
    }
  });

  await Promise.all(work);
  return { stored, failed };
}

/**
 * Ask the CDN for the conversion rather than doing it here.
 *
 * pbs.twimg.com serves webp at a quarter the size of the original jpeg, and
 * TikTok's image CDN serves what it is given. Either way nothing is decoded
 * locally, which is what keeps this runnable inside a Worker.
 */
function variant(originUrl: string): string {
  try {
    const url = new URL(originUrl);
    if (!url.hostname.endsWith("twimg.com")) return originUrl;
    url.pathname = url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, "");
    url.searchParams.set("format", "webp");
    url.searchParams.set("name", "small");
    return url.toString();
  } catch {
    return originUrl;
  }
}

/** Sharded two levels, so no directory or R2 prefix holds thousands. */
function keyFor(id: string): string {
  const flat = id.replace(/-/g, "");
  return `${flat.slice(0, 2)}/${flat.slice(2, 4)}/${flat}.webp`;
}
