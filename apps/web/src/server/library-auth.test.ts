import { describe, expect, test } from "bun:test";
import { handleApi } from "./api.ts";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
const local = openLocalDb(":memory:"); migrateLocalDb(local);
const env = {db:local as unknown as AnansiDb,libraryToken:"test-library-secret",ingestToken:"test-ingest-secret"};
const origin="https://anansi.test";
const request=(path:string,init?:RequestInit)=>new Request(origin+path,init);
describe("whole-library authentication",()=>{
  test("reads, media, export and mutations are closed before accessing the database",async()=>{
    for (const [path,method] of [["/api/items","GET"],["/api/stats","GET"],["/api/media/ab/cd/abcd.png","GET"],["/api/export","GET"],["/api/items/archive","POST"],["/api/collections","GET"]]) {
      expect((await handleApi(env,request(path!,{method}))).status).toBe(401);
      expect((await handleApi({db:env.db},request(path!,{method}))).status).toBe(503);
    }
  });
  test("ingest credential cannot read library, library credential cannot read extension config",async()=>{
    expect((await handleApi(env,request("/api/stats",{headers:{authorization:`Bearer ${env.ingestToken}`}}))).status).toBe(401);
    expect((await handleApi(env,request("/api/extension/config",{headers:{authorization:`Bearer ${env.libraryToken}`}}))).status).toBe(401);
    expect((await handleApi(env,request("/api/extension/stats",{headers:{authorization:`Bearer ${env.ingestToken}`}}))).status).toBe(200);
  });
  test("exchange, authenticated read, CSRF rejection, tampering, rotation and logout",async()=>{
    const login=await handleApi(env,request("/api/auth/session",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({token:env.libraryToken})}));
    expect(login.status).toBe(200);
    const setCookie=login.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");expect(setCookie).toContain("Secure");expect(setCookie).toContain("SameSite=Strict");
    const cookie=setCookie.split(";")[0]!;
    expect((await handleApi(env,request("/api/stats",{headers:{cookie}}))).status).toBe(200);
    expect((await handleApi(env,request("/api/items/archive",{method:"POST",headers:{cookie,origin:"https://evil.test"},body:'{"ids":[]}'}))).status).toBe(403);
    expect((await handleApi(env,request("/api/items/archive",{method:"POST",headers:{cookie,origin},body:'{"ids":[]}'}))).status).toBe(200);
    expect((await handleApi(env,request("/api/stats",{headers:{cookie:cookie+"bad"}}))).status).toBe(401);
    expect((await handleApi({...env,libraryToken:"rotated"},request("/api/stats",{headers:{cookie}}))).status).toBe(401);
    const logout=await handleApi(env,request("/api/auth/session",{method:"DELETE",headers:{cookie,origin}}));
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  test("login rejects cross-origin and bad credentials; session status reveals no secret",async()=>{
    expect((await handleApi(env,request("/api/auth/session",{method:"POST",headers:{origin:"https://evil.test"},body:JSON.stringify({token:env.libraryToken})}))).status).toBe(403);
    expect((await handleApi(env,request("/api/auth/session",{method:"POST",headers:{origin},body:'{"token":"wrong"}'}))).status).toBe(401);
    const status = await (await handleApi(env,request("/api/auth/session"))).json() as unknown;
    expect(status).toEqual({configured:true,authenticated:false});
  });
});
