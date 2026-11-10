import { FetchBudget } from "./fetch-budget.ts";
import { fetchPendingAvatars, fetchPendingMedia, type MediaSource } from "./media.ts";
import { parsePreview } from "@anansi/sources/link-preview";
import { isFetchableMediaUrl } from "./media.ts";
import { publicFetch } from "./public-fetch.ts";
import { items, media, type AnansiDb } from "@anansi/db";
import { sql, eq } from "drizzle-orm";
export const PREVIEW_BYTES = 512 * 1024;
export const previewDelay = (attempt: number) => Math.min(86400, 300 * 2 ** (attempt - 1));
type Transport = (url: URL, signal: AbortSignal) => Promise<Response>;
export async function fetchPreview(target: string, transport: Transport = (u,s) => publicFetch(u,s,"local"), timeoutMs = 8000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("preview timeout")); }, timeoutMs); });
  const work = async () => {
    let url = new URL(target);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!isFetchableMediaUrl(url.href)) throw new Error("refused preview URL");
      const response = await transport(url, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location || redirects === 3) throw new Error("preview redirect limit");
        url = new URL(location, url); continue;
      }
      if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get("content-type") || "")) { await response.body?.cancel(); throw new Error("preview requires HTML"); }
      if (Number(response.headers.get("content-length")) > PREVIEW_BYTES) { await response.body?.cancel(); throw new Error("preview too large"); }
      const reader = response.body?.getReader(); if (!reader) return parsePreview("",url.href);
      const decoder = new TextDecoder(); let html = "", bytes = 0;
      const abort = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener("abort", abort, {once:true});
      try { while (true) { const {done,value} = await reader.read(); if (done) break; bytes += value.length; if (bytes > PREVIEW_BYTES) throw new Error("preview too large"); html += decoder.decode(value,{stream:true}); } }
      finally { controller.signal.removeEventListener("abort",abort); await reader.cancel().catch(()=>{}); reader.releaseLock(); }
      return parsePreview(html + decoder.decode(), url.href);
    }
    throw new Error("preview redirect limit");
  };
  try { return await Promise.race([work(), expired]); } finally { clearTimeout(timer!); }
}
/** Budgeted pages per invocation; persisted lease and attempts make overlapping ticks safe. */
export async function processLinkPreviews(db: AnansiDb, runtime: "local" | "worker" = "local", transport?: Transport, now = Math.floor(Date.now()/1000), budget = new FetchBudget(), ids?: string[], source?: MediaSource) {
  await db.run(sql`INSERT OR IGNORE INTO link_preview_jobs(item_id) SELECT id FROM items WHERE source='web' AND NOT EXISTS (SELECT 1 FROM media WHERE media.item_id=items.id)`);
  while (budget.canStart()) {
  const rows = await db.all<{item_id:string;url:string;attempts:number}>(sql`SELECT j.item_id,i.url,j.attempts FROM link_preview_jobs j JOIN items i ON i.id=j.item_id WHERE j.done=0 AND j.attempts<3 AND j.next_run_at<=${now} AND i.source='web' AND (${ids ? sql`j.attempts=0 AND j.item_id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})` : sql`1=1`}) ORDER BY j.next_run_at,i.saved_at DESC LIMIT 1`);
  if (!rows.length) break;
  for (const row of rows) {
    const token = crypto.randomUUID();
    const claimed = await db.all(sql`UPDATE link_preview_jobs SET attempts=attempts+1,next_run_at=${now+120},claim_token=${token} WHERE item_id=${row.item_id} AND next_run_at<=${now} AND done=0 AND attempts=${row.attempts} RETURNING item_id`);
    if (!claimed.length) continue;
    try {
      const preview = await fetchPreview(row.url, transport ? ((u,s) => { budget.consume(3); return transport(u,s); }) : ((u,s)=>publicFetch(u,s,runtime,fetch,budget)), Math.min(8000,budget.remainingMs));
      if (preview.image && isFetchableMediaUrl(preview.image)) await db.insert(media).values({id:crypto.randomUUID(),itemId:row.item_id,kind:"card",originUrl:preview.image}).onConflictDoNothing();
      if (preview.favicon && isFetchableMediaUrl(preview.favicon)) await db.insert(media).values({id:crypto.randomUUID(),itemId:row.item_id,kind:"favicon",originUrl:preview.favicon}).onConflictDoNothing();
      // Existing excerpt/search field; preserve owner or explicit capture content.
      await db.update(items).set({body:sql`CASE WHEN coalesce(body,'')='' THEN ${preview.description} ELSE body END`, authorName:sql`coalesce(author_name,${preview.siteName || null})`, raw:sql`json_set(raw, '$.linkPreview.siteName', ${preview.siteName})`}).where(eq(items.id,row.item_id));
      await db.run(sql`UPDATE link_preview_jobs SET done=1,claim_token=NULL WHERE item_id=${row.item_id} AND claim_token=${token}`);
      if (source) for (let i=0;i<2 && budget.canStart();i++) await fetchPendingMedia(db,source,1,budget,row.item_id);
    } catch {
      await db.run(sql`UPDATE link_preview_jobs SET next_run_at=${now+previewDelay(row.attempts+1)},claim_token=NULL WHERE item_id=${row.item_id} AND claim_token=${token}`);
    }
  }
}

}
/** One budget covers pages, DNS and all resulting media hops. */
export async function runPreviewPass(db: AnansiDb, source: MediaSource, ids?: string[]) {
  const budget = new FetchBudget();
  await fetchPendingAvatars(db, source, 2, budget);
  // Interleave one page with its media rather than starving covers behind the backlog.
  while (budget.canStart()) {
    const before = budget.used;
    await processLinkPreviews(db, source.runtime, undefined, undefined, budget, ids, source);
    if (budget.canStart()) await fetchPendingMedia(db, source, 1, budget);
    if (budget.used === before) break;
  }
  return {subrequests: budget.used};
}
