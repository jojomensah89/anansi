import { eq, isNull, sql } from "drizzle-orm";
import { media } from "./schema.ts";
import type { AnansiDb } from "./types.ts";

export interface PendingMedia {
  id: string;
  itemId: string;
  kind: string;
  originUrl: string;
}

/** Media rows that have never been stored anywhere. */
export async function pendingMedia(db: AnansiDb, limit?: number): Promise<PendingMedia[]> {
  const q = db
    .select({
      id: media.id,
      itemId: media.itemId,
      kind: media.kind,
      originUrl: media.originUrl,
    })
    .from(media)
    .where(isNull(media.storedKey));
  return limit ? q.limit(limit) : q;
}

export async function markMediaStored(db: AnansiDb, id: string, key: string): Promise<void> {
  await db.update(media).set({ storedKey: key }).where(eq(media.id, id));
}

export async function mediaStats(db: AnansiDb): Promise<{ total: number; stored: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      stored: sql<number>`sum(case when ${media.storedKey} is null then 0 else 1 end)`,
    })
    .from(media);
  return { total: row?.total ?? 0, stored: row?.stored ?? 0 };
}
