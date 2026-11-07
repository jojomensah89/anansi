import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTestDb } from "../../../../packages/db/src/test-db.ts";
import { upsertItems } from "@anansi/db";
import { media } from "@anansi/db/schema";
import { cleanupOrphanedMedia } from "./media.ts";
const kept="aa/bb/keep.jpg", orphan="aa/bb/orphan.jpg", later="aa/bb/later.jpg";
async function setup() {
 const db=openTestDb();await upsertItems(db,[{source:"web",externalId:"1",url:"https://example.com",kind:"article",body:"media",savedAt:1,savedAtIsExact:true,metrics:{},links:[],raw:{},media:[{kind:"image",originUrl:"https://example.com/a"}]}]);
 await db.update(media).set({storedKey:kept});
 for(const key of [kept,orphan,later])await db.run(sql`INSERT INTO media_orphan_objects VALUES (${key})`);
 return db;
}
test("bounded R2 cleanup protects references and retries errors",async()=>{
 const db=await setup();const deleted:string[]=[];const bucket={get:async()=>null,delete:async(key:string)=>{deleted.push(key);if(key===later)throw Error("retry");}};
 expect(await cleanupOrphanedMedia(db,{bucket},1)).toBe(0);expect(deleted).toEqual([]);
 expect(await cleanupOrphanedMedia(db,{bucket},1)).toBe(0);
 expect(await db.all(sql`SELECT * FROM media_orphan_objects`)).toHaveLength(2);
 expect(await cleanupOrphanedMedia(db,{bucket},20)).toBe(1);expect(deleted).not.toContain(kept);
});
test("local cleanup removes only queued unreferenced files",async()=>{
 const db=await setup();const dir=await mkdtemp(join(tmpdir(),"anansi-media-"));
 try {await mkdir(join(dir,"aa/bb"),{recursive:true});for(const key of [kept,orphan,later,"aa/bb/unlisted.jpg"])await Bun.write(join(dir,key),"image");
 expect(await cleanupOrphanedMedia(db,{dir},20)).toBe(2);await access(join(dir,kept));await access(join(dir,"aa/bb/unlisted.jpg"));expect(await Bun.file(join(dir,orphan)).exists()).toBe(false);
 } finally {await rm(dir,{recursive:true,force:true});}
});


