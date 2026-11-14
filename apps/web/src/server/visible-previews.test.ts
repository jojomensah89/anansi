import {test,expect} from "bun:test";
import {handleApi} from "./api.ts";
import {openLocalDb,migrateLocalDb} from "@anansi/db/local";
import {createClient,authorizeClient} from "./clients.ts";
import {sql} from "drizzle-orm";
test("visible route requires owner auth, caps ids, dedupes and ignores unknown/non-web",async()=>{
 const db=openLocalDb(":memory:");migrateLocalDb(db);
 const env={db,libraryToken:"owner",ingestToken:"capture",media:{put:async()=>{}}};
 const call=(ids:unknown,token?:string)=>handleApi(env,new Request("http://localhost/api/link-previews/visible",{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({ids})}));
 expect((await call([])).status).toBe(401);
 for(const kind of ["extension","api","app"] as const){const client=await createClient(db,kind,kind);expect((await call([],client.key)).status).toBe(401);expect((await authorizeClient(env,new Request("http://localhost/api/link-previews/visible",{method:"POST",headers:{authorization:`Bearer ${client.key}`}})))?.status).toBe(401);}
 expect((await call([],"anansi_at_fixture")).status).toBe(401);
 expect((await call(Array(13).fill("unknown"),"owner")).status).toBe(400);
 expect((await call([1],"owner")).status).toBe(400);
 await db.run(sql`INSERT INTO items(id,source,external_id,url,kind,saved_at,raw) VALUES('x','x','x','https://x.com/x','post',1,'{}')`);
 const response=await call(["unknown","unknown","x"],"owner");expect(response.status).toBe(200);expect(await response.json() as unknown).toEqual({subrequests:0});
 expect(await db.all(sql`SELECT * FROM link_preview_jobs`)).toHaveLength(0);
 await db.run(sql`INSERT INTO items(id,source,external_id,url,kind,saved_at,raw) VALUES('web','web','web','http://127.0.0.1/private','page',1,'{}')`);
 expect((await call(["web","web","unknown","x"],"owner")).status).toBe(200);
 expect((await db.all<{attempts:number}>(sql`SELECT attempts FROM link_preview_jobs WHERE item_id='web'`))[0]?.attempts).toBe(1);
 // Already attempted pages stay under durable backoff, regardless of repeated visible requests.
 await call(["web"],"owner");expect((await db.all<{attempts:number}>(sql`SELECT attempts FROM link_preview_jobs WHERE item_id='web'`))[0]?.attempts).toBe(1);
});
