import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { exportLibrary, restoreLibrary, upsertItems, getItem, listItems, creatorPage, searchItems, getItems, type AnansiDb } from "@anansi/db";
import { cleanupOrphanedAvatars, fetchPendingAvatars, type MediaSource } from "./media.ts";
import { FetchBudget } from "./fetch-budget.ts";
const png=new Uint8Array([137,80,78,71,13,10,26,10,0]);
const url="https://pbs.twimg.com/avatar.png";
async function fixture() {
 const local=openLocalDb(":memory:"); migrateLocalDb(local); const db=local as unknown as AnansiDb;
 await upsertItems(db,[1,2,3].map(n=>({source:"x",externalId:String(n),url:`https://x.com/a/status/${n}`,kind:"post",authorHandle:"a",authorAvatar:n===3 ? url+"?signed=2" : url,body:"hello",savedAt:n,savedAtIsExact:true,metrics:{},media:[],links:[],raw:{}})));
 return {db,local};
}
test("avatar archival deduplicates URLs and content; all read boundaries prefer storage",async()=>{
 const {db,local}=await fixture(); const previous=globalThis.fetch; let fetches=0; const writes:string[]=[];
 globalThis.fetch=(async()=>{fetches++;return new Response(png,{headers:{"content-type":"image/png"}});}) as unknown as typeof fetch;
 const source:MediaSource={runtime:"worker",put:async key=>{writes.push(key);}};
 try {
  const before=await listItems(db,{}); const id=before.items[0]!.id;
  expect((await getItem(db,id))!.authorAvatar).toStartWith(url);
  // Only the author's latest picture (item 3) is fetched; the superseded URL is not.
  expect(await fetchPendingAvatars(db,source)).toEqual({stored:1,failed:0});
  expect(fetches).toBe(1); expect(writes).toHaveLength(1);
  expect(writes[0]).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);
  expect((await getItem(db,id))!.authorAvatar).toBe(`/api/media/${writes[0]}`);
  expect((await listItems(db,{})).items.every(i=>i.authorAvatar===`/api/media/${writes[0]}`)).toBe(true);
  expect((await creatorPage(db)).creators[0]!.authorAvatar).toBe(`/api/media/${writes[0]}`);
  expect(await fetchPendingAvatars(db,source)).toEqual({stored:0,failed:0}); expect(fetches).toBe(1);
  const backup=await exportLibrary(db);
  expect(backup.items.every(i=>i.authorAvatar!.startsWith(url))).toBe(true);
  const restored=openLocalDb(":memory:"); migrateLocalDb(restored);
  try {
   await restoreLibrary(restored as unknown as AnansiDb,backup);
   expect((await getItem(restored as unknown as AnansiDb,id))!.authorAvatar).toStartWith(url);
  } finally {restored.$client.close();}
 } finally {globalThis.fetch=previous;local.$client.close();}
});
test("avatar failures preserve original and backfill respects limits, budgets and leases",async()=>{
 const {db,local}=await fixture(); const previous=globalThis.fetch; let fetches=0;
 globalThis.fetch=(async()=>{fetches++;return new Response("expired",{status:403});}) as unknown as typeof fetch;
 const source:MediaSource={runtime:"worker",put:async()=>{}};
 try {
  expect(await fetchPendingAvatars(db,source,2,new FetchBudget(0))).toEqual({stored:0,failed:0}); expect(fetches).toBe(0);
  expect(await fetchPendingAvatars(db,source,1)).toEqual({stored:0,failed:1}); expect(fetches).toBe(1);
  expect((await listItems(db,{})).items.every(i=>i.authorAvatar!.startsWith(url))).toBe(true);
  await db.run(sql`UPDATE author_avatars SET next_run_at=0`);
  const passes=await Promise.all([fetchPendingAvatars(db,source,1),fetchPendingAvatars(db,source,1)]);
  expect(passes.reduce((n,p)=>n+p.failed,0)).toBeLessThanOrEqual(2);
  expect(fetches).toBeLessThanOrEqual(3);
 } finally {globalThis.fetch=previous;local.$client.close();}
});

test("a partially spent budget stops the next avatar and active leases prevent duplicate fetches",async()=>{
 const {db,local}=await fixture(); const previous=globalThis.fetch; let fetches=0;
 globalThis.fetch=(async()=>{fetches++;return new Response(png,{headers:{"content-type":"image/png"}});}) as unknown as typeof fetch;
 const source:MediaSource={runtime:"worker",put:async()=>{}};
 try {
  const budget=new FetchBudget(12);
  expect(await fetchPendingAvatars(db,source,2,budget)).toEqual({stored:1,failed:0});
  expect(fetches).toBe(1); expect(budget.used).toBe(1);
  await db.run(sql`UPDATE author_avatars SET next_run_at=${Math.floor(Date.now()/1000)+120} WHERE stored_key IS NULL`);
  expect(await fetchPendingAvatars(db,source)).toEqual({stored:0,failed:0}); expect(fetches).toBe(1);
 } finally {globalThis.fetch=previous;local.$client.close();}
});


test("latest captured author avatar resolves across list, search, detail and creators with indexed seeks", async () => {
 const {db,local}=await fixture();
 try {
  // Publication order deliberately disagrees with capture order; blank newest avatar is ignored.
  await db.run(sql`UPDATE items SET posted_at=100-saved_at`);
  await db.run(sql`INSERT INTO items(id,source,external_id,url,kind,author_handle,author_avatar,saved_at,raw)
   VALUES ('blank','x','blank','u','post','a','',99,'{}'),
          ('anonymous','x','anon','u','post',NULL,'own',100,'{}'),
          ('other-source','github','other','u','repo','a','other',200,'{}')`);
  const latest=url+"?signed=2";
  const ids=(await listItems(db,{source:"x"})).items.filter(i=>i.author==="a").map(i=>i.id);
  for (const avatar of [latest,"/api/media/stored.png"]) {
   if (avatar!==latest) await db.run(sql`INSERT INTO author_avatars(origin_url,stored_key) VALUES (${latest},'stored.png')`);
   expect((await listItems(db,{source:"x"})).items.filter(i=>i.author==="a").every(i=>i.authorAvatar===avatar)).toBe(true);
   expect((await getItems(db,ids)).items.every(i=>i.authorAvatar===avatar)).toBe(true);
   expect((await searchItems(db,{query:"hello",source:"x"})).every(i=>i.authorAvatar===avatar)).toBe(true);
   expect((await creatorPage(db,{source:["x"]})).creators[0]!.authorAvatar).toBe(avatar);
   expect((await getItem(db,"anonymous"))!.authorAvatar).toBe("own");
   expect((await getItem(db,"other-source"))!.authorAvatar).toBe("other");
  }
  const plan=local.$client.query(`EXPLAIN QUERY PLAN SELECT
   (SELECT latest.author_avatar FROM items latest WHERE latest.source=i.source
    AND latest.author_handle=i.author_handle AND latest.author_avatar IS NOT NULL
    AND latest.author_avatar<>'' ORDER BY latest.saved_at DESC,latest.id DESC LIMIT 1)
   FROM items i`).all() as {detail:string}[];
  expect(plan.some(p=>p.detail.includes("USING INDEX items_author_avatar_latest (source=? AND author_handle=?)"))).toBe(true);
  expect(plan.some(p=>p.detail.includes("TEMP B-TREE"))).toBe(false);
 } finally { local.$client.close(); }
});

test("avatar GC is bounded, retains shared objects and post media, and retries failures",async()=>{
 const {db,local}=await fixture(); const deleted:string[]=[];
 const key=(n:number)=>`aa/bb/${String(n).padStart(64,"0")}.png`;
 const source:MediaSource={bucket:{get:async()=>null,delete:async k=>{deleted.push(k);}}};
 try {
  await db.run(sql`INSERT INTO author_avatars(origin_url,stored_key) VALUES
   ('a-orphan',${key(1)}),('b-orphan',${key(2)}),(${url},${key(2)}),
   ('c-post',${key(3)}),('d-orphan',${key(4)}),('e-orphan',${key(5)})`);
  await db.run(sql`INSERT INTO media(id,item_id,kind,origin_url,stored_key) SELECT 'post-media',id,'image','post',${key(3)} FROM items LIMIT 1`);
  expect(await cleanupOrphanedAvatars(db,source,100)).toBe(4);
  expect(deleted).toEqual([key(1),key(4)]);
  expect((await db.all(sql`SELECT * FROM author_avatars WHERE origin_url='e-orphan'`)).length).toBe(1);
  const failing:MediaSource={bucket:{get:async()=>null,delete:async()=>{throw new Error("offline");}}};
  expect(await cleanupOrphanedAvatars(db,failing)).toBe(0);
  // e-orphan, plus the superseded picture: key(2) goes once its last row does.
  expect(await cleanupOrphanedAvatars(db,source)).toBe(2);
  expect(deleted).toContain(key(2)); expect(deleted).not.toContain(key(3));
 } finally {local.$client.close();}
});


