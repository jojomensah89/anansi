import { describe, expect, test } from "bun:test";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { upsertItems, claimMediaJobs, completeMediaJob, failMediaJob, type AnansiDb } from "@anansi/db";
import { mediaJobs } from "./media-jobs-schema.ts";
import { media } from "./schema.ts";
const create=async(count=3)=>{
  const local=openLocalDb(":memory:");migrateLocalDb(local);const db=local as unknown as AnansiDb;
  await upsertItems(db,Array.from({length:count},(_,i)=>({source:"x",externalId:`test-${i}`,url:`https://x.com/user/status/${i}`,kind:"post",body:"media",savedAt:100,savedAtIsExact:true,metrics:{},links:[],raw:{},media:[{kind:"photo",originUrl:`https://pbs.twimg.com/media/${i}.png`}]})));
  return {local,db};
};
describe("durable media jobs",()=>{
  test("concurrent claims never share work, failed head does not starve later rows",async()=>{
    const {db,local}=await create();
    const [a,b]=await Promise.all([claimMediaJobs(db,1,100),claimMediaJobs(db,1,100)]);
    expect(a.length+b.length).toBe(1);
    const job=[...a,...b][0]!;
    await failMediaJob(db,job.id,job.token,job.attempts,"HTTP 503",100);
    const next=await claimMediaJobs(db,1,100);
    expect(next).toHaveLength(1);expect(next[0]!.id).not.toBe(job.id);
    const saved=await local.select().from(mediaJobs);
    const failed=saved.find(row=>row.mediaId===job.id)!;
    expect(failed.attempts).toBe(1);expect(failed.nextRunAt).toBe(160);expect(failed.lastError).toBe("HTTP 503");
  });
  test("expired leases recover and an old owner cannot complete a new claim",async()=>{
    const {db,local}=await create(1);
    const [first]=await claimMediaJobs(db,1,100);
    expect(await claimMediaJobs(db,1,219)).toHaveLength(0);
    const [second]=await claimMediaJobs(db,1,220);
    expect(second!.attempts).toBe(2);
    await completeMediaJob(db,first!.id,first!.token,"old.webp");
    expect((await local.select().from(media))[0]!.storedKey).toBeNull();
    await completeMediaJob(db,second!.id,second!.token,"new.png");
    expect((await local.select().from(media))[0]!.storedKey).toBe("new.png");
    expect(await claimMediaJobs(db,1,400)).toHaveLength(0);
  });
});
