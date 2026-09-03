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
