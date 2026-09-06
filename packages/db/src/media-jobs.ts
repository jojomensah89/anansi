import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { media } from "./schema.ts";
import { mediaJobs } from "./media-jobs-schema.ts";
import type { AnansiDb } from "./types.ts";

/** Database leases survive restarts and are claimed atomically across requests. */
export async function claimMediaJobs(db: AnansiDb, limit = 4, now = Math.floor(Date.now() / 1000)) {
  await db.run(sql`INSERT OR IGNORE INTO media_jobs(media_id) SELECT id FROM media WHERE stored_key IS NULL`);
  const candidates = await db.select({ id: mediaJobs.mediaId }).from(mediaJobs).innerJoin(media, eq(media.id, mediaJobs.mediaId))
    .where(and(isNull(media.storedKey), lte(mediaJobs.nextRunAt, now), lte(mediaJobs.leaseUntil, now)))
    .orderBy(mediaJobs.nextRunAt, mediaJobs.mediaId).limit(Math.min(Math.max(limit, 1), 20));
  const claimed = [];
  for (const row of candidates) {
    const token = crypto.randomUUID();
    const won = await db.update(mediaJobs).set({ claimToken: token, leaseUntil: now + 120, attempts: sql`${mediaJobs.attempts} + 1` })
      .where(and(eq(mediaJobs.mediaId, row.id), lte(mediaJobs.nextRunAt, now), lte(mediaJobs.leaseUntil, now))).returning();
    if (!won.length) continue;
    const [asset] = await db.select().from(media).where(eq(media.id, row.id));
    if (asset && !asset.storedKey) claimed.push({ ...asset, token, attempts: won[0]!.attempts });
  }
  return claimed;
}
export async function completeMediaJob(db: AnansiDb, id: string, token: string, key: string): Promise<void> {
  // Conditional subquery prevents an expired worker from acknowledging a newer claim.
  await db.update(media).set({ storedKey: key }).where(and(eq(media.id, id), sql`EXISTS (SELECT 1 FROM media_jobs WHERE media_id=${id} AND claim_token=${token})`));
  await db.delete(mediaJobs).where(and(eq(mediaJobs.mediaId, id), eq(mediaJobs.claimToken, token)));
}
export async function failMediaJob(db: AnansiDb, id: string, token: string, attempts: number, error: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const delay = Math.min(86400, 60 * 2 ** Math.min(Math.max(attempts - 1, 0), 11));
  await db.update(mediaJobs).set({ claimToken: null, leaseUntil: 0, nextRunAt: now + delay, lastError: error.slice(0, 500) })
    .where(and(eq(mediaJobs.mediaId, id), eq(mediaJobs.claimToken, token)));
}
