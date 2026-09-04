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
/**
 * Where a thumbnail is allowed to come from.
 *
 * This is the one place the server makes a request to a URL that a *page*
 * chose. Platform CDNs were the only source of these until webpage capture
 * arrived; now saving a hostile page can put any http(s) URL in front of this
 * fetch, which is a request-forgery primitive pointed at whatever the server
 * can reach — a metadata endpoint, something on the loopback interface, a box
 * on the same network.
 *
 * So the rule is the network location, not the content: an address that is not
 * publicly routable is refused, whatever it claims to serve.
 */
const PRIVATE_V4 =
	/^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

const PRIVATE_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export function isFetchableMediaUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.username !== "" || url.password !== "") return false;

	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (PRIVATE_HOSTS.has(host)) return false;
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return false;
	}
	if (PRIVATE_V4.test(host)) return false;
	// IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
	if (host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
	// An IPv4-mapped IPv6 address hides the same private ranges, and URL
	// normalizes it to hex — ::ffff:127.0.0.1 arrives as ::ffff:7f00:1 — so the
	// dotted form has to be reconstructed before the v4 rules can see it.
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (mapped) {
		const high = Number.parseInt(mapped[1] ?? "", 16);
		const low = Number.parseInt(mapped[2] ?? "", 16);
		const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
		if (PRIVATE_V4.test(dotted)) return false;
	}
	if (host.startsWith("::ffff:") && PRIVATE_V4.test(host.slice(7))) return false;
	return true;
}

/** A thumbnail is an image, and a bounded one. */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

async function fetchThumbnail(target: string): Promise<ArrayBuffer> {
	if (!isFetchableMediaUrl(target)) throw new Error("refused media url");

	// Manual redirects: following automatically would let a public URL hand
	// back a Location pointing at the loopback interface, which is exactly the
	// check above being walked around.
	const res = await fetch(target, { redirect: "manual" });
	if (res.status >= 300 && res.status < 400) throw new Error("media url redirected");
	if (!res.ok) throw new Error(String(res.status));

	const type = res.headers.get("content-type") ?? "";
	if (!type.startsWith("image/")) throw new Error("not an image");

	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
		throw new Error("media too large");
	}

	const bytes = await res.arrayBuffer();
	// Checked again: content-length is a claim, not a measurement.
	if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("media too large");
	return bytes;
}

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
      const bytes = await fetchThumbnail(variant(row.originUrl));
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
      // A dead thumbnail is normal — posts get deleted, accounts go private,
      // and a refused address is a refusal working. None of it may take an
      // ingest down.
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
