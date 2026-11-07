import { expect, test } from "bun:test";
import { openTestDb } from "./test-db.ts";
import { upsertItems } from "./queries.ts";
import { getItem, listItems } from "./search.ts";
import { media } from "./schema.ts";
import { claimMediaJobs, completeMediaJob } from "./media-jobs.ts";
import { exportLibrary, restoreLibrary } from "./organization.ts";
import { RESTORE_TABLES, restoreCounts, startLibraryRestore, writeLibraryRestoreChunk, finishLibraryRestore } from "./restore.ts";
import { validateRestoreBackup } from "./restore-preflight.ts";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { MEDIA_IDENTITY_SQL } from "./media-identity.ts";
const item = (source: string, urls: string[]) => ({source, externalId:"1",url:"https://example.com/1",kind:"post",savedAt:100,savedAtIsExact:true,metrics:{},links:[],raw:{},media:urls.map(originUrl=>({kind:"image",originUrl}))});
test("three re-signed captures preserve stored ID/key and schedule no download; pending links refresh", async()=>{
 const db=openTestDb(); const base="https://p16-common-sign.tiktokcdn.com/a";
 await upsertItems(db,[item("tiktok",[base+"?sig=old"])]);
 await upsertItems(db,[item("tiktok",[base+"?sig=fresh"])]);
 expect((await db.select().from(media))[0]!.originUrl).toBe(base+"?sig=fresh");
 const [job]=await claimMediaJobs(db); await completeMediaJob(db,job!.id,job!.token,"aa/bb/saved.jpg");
 for(let i=0;i<3;i++) {await upsertItems(db,[item("tiktok",[base+"?sig="+i])]);expect(await claimMediaJobs(db)).toHaveLength(0);}
 const rows=await db.select().from(media);expect(rows).toHaveLength(1);expect(rows[0]!.id).toBe(job!.id);expect(rows[0]!.storedKey).toBe("aa/bb/saved.jpg");
 expect((await getItem(db,rows[0]!.itemId))!.media.filter(m=>m.storedKey)).toHaveLength(1);
 expect((await listItems(db,{})).items[0]!.media).toHaveLength(1);
 expect((await exportLibrary(db)).media).toHaveLength(1);
});
test("distinct X/TikTok paths and arbitrary web query identities survive",async()=>{
 for(const [source,urls] of [["x",["https://pbs.twimg.com/media/a?format=jpg&name=small","https://pbs.twimg.com/media/b?format=jpg"]],["tiktok",["https://p16.tiktokcdn.com/a?q=1","https://p16.tiktokcdn.com/b?q=1"]],["web",["https://example.com/image?id=1","https://example.com/image?id=2"]]] as [string,string[]][]) {
 const db=openTestDb();await upsertItems(db,[item(source,urls)]);expect(await db.select().from(media)).toHaveLength(2);
 }
 const db=openTestDb();await upsertItems(db,[item("x",["https://pbs.twimg.com/media/a.jpg","https://pbs.twimg.com/media/a?format=webp&name=small"])]);expect(await db.select().from(media)).toHaveLength(1);
});
test("one TikTok image served from two mirror hosts is one image, while other hosts stay separate",async()=>{
 const db=openTestDb();await upsertItems(db,[item("tiktok",["https://p16-common-sign.tiktokcdn.com/tos-x/hash~tplv.image?x-signature=a","https://p19-common-sign.tiktokcdn.com/tos-x/hash~tplv.image?x-signature=b","https://p16-common-sign.tiktokcdn.com/tos-x/other~tplv.image?x-signature=c"])]);
 expect(await db.select().from(media)).toHaveLength(2);
 const reddit=openTestDb();await upsertItems(reddit,[item("reddit",["https://preview.redd.it/a.png?s=1","https://external-preview.redd.it/a.png?s=2"])]);
 expect(await reddit.select().from(media)).toHaveLength(2);
});
test("older backups deduplicate through both restore paths",async()=>{
 const source=openTestDb();await upsertItems(source,[item("tiktok",["https://p16.tiktokcdn.com/a?q=1"])]);const backup=await exportLibrary(source);
 delete (backup.media[0] as any).identity;backup.media.push({...backup.media[0]!,id:"duplicate",originUrl:"https://p16.tiktokcdn.com/a?q=2"});
 validateRestoreBackup(backup);
 const db=openTestDb();await restoreLibrary(db,backup);expect((await exportLibrary(db)).media).toHaveLength(1);
 const chunked=openTestDb();const backupId="a".repeat(64);await startLibraryRestore(chunked,backupId,restoreCounts(backup));
 for(const table of RESTORE_TABLES) {const rows=backup[table]??[];if(rows.length)await writeLibraryRestoreChunk(chunked,{backupId,table,offset:0,rows});}
 await finishLibraryRestore(chunked,backupId);expect((await exportLibrary(chunked)).media).toHaveLength(1);
});
test("migration keeps oldest stored copy, repoints jobs, queues only losers and is safe without duplicates",()=>{
 const folder=new URL("../drizzle/",import.meta.url);const db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");
 for(const file of readdirSync(folder).filter(f=>f.endsWith(".sql")&&!f.startsWith("0022")).sort())db.exec(readFileSync(new URL(file,folder),"utf8"));
 db.exec(`INSERT INTO items(id,source,external_id,url,kind,saved_at,raw) VALUES('i','tiktok','1','u','post',1,'{}');
 INSERT INTO media(id,item_id,kind,origin_url,stored_key) VALUES('pending','i','image','https://p16.tiktokcdn.com/a?q=1',NULL),('stored','i','image','https://p16.tiktokcdn.com/a?q=2','aa/bb/keep.jpg'),('later','i','image','https://p16.tiktokcdn.com/a?q=3','aa/bb/remove.jpg');
 INSERT INTO media_jobs(media_id) VALUES('pending');`);
 const migration=readFileSync(new URL("0022_media_identity.sql",folder),"utf8");expect(migration).toContain(MEDIA_IDENTITY_SQL);db.exec(migration);
 expect(db.query("SELECT id FROM media").all()).toEqual([{id:"stored"}]);expect(db.query("SELECT media_id FROM media_jobs").all()).toEqual([{media_id:"stored"}]);expect(db.query("SELECT stored_key FROM media_orphan_objects").all()).toEqual([{stored_key:"aa/bb/remove.jpg"}]);expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
 const empty=new Database(":memory:");for(const file of readdirSync(folder).filter(f=>f.endsWith(".sql")).sort())empty.exec(readFileSync(new URL(file,folder),"utf8"));empty.close();
});

