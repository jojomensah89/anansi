import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataPath } from "../store/files.ts";

/**
 * Where thumbnails land.
 *
 * Same shape as the database driver seam: one interface, a local
 * implementation for the self-hosted path and an R2 one for the hosted tier,
 * and nothing above knows which it got. Media on disk is the default because
 * days 1-7 are supposed to work without a Cloudflare account existing.
 */
export interface MediaSink {
  readonly name: string;
  has(key: string): Promise<boolean>;
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
}

export function localSink(dir = dataPath("media")): MediaSink {
  return {
    name: `local (${dir})`,
    async has(key) {
      return Bun.file(join(dir, key)).exists();
    },
    async put(key, bytes) {
      const path = join(dir, key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
    },
  };
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2Config(): R2Config | undefined {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return undefined;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/**
 * R2 is S3-compatible and Bun ships an S3 client, so the hosted path needs no
 * dependency at all — which matters because this same code will run inside a
 * Worker later, where an aws-sdk bundle would be absurd.
 *
 * Untested against a live bucket: it needs a Cloudflare account, which days
 * 1-7 deliberately do not require.
 */
export function r2Sink(config: R2Config): MediaSink {
  const client = new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
  });

  return {
    name: `r2 (${config.bucket})`,
    async has(key) {
      return client.file(key).exists();
    },
    async put(key, bytes, contentType) {
      await client.file(key).write(bytes, { type: contentType });
    },
  };
}
