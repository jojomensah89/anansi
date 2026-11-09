import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {openLocalDb,migrateLocalDb} from "@anansi/db/local";
import {upsertItems,items,getAiSettings,setAiSettings,stageSemanticChunks,markSemanticChunksComplete,type AnansiDb} from "@anansi/db";
import {oauthTokens} from "../../../../packages/db/src/schema.ts";
import {createClient,setClientWrite,updateClient} from "./clients.ts";
import {handleMcp} from "./mcp.ts";
import {handleApi} from "./api.ts";
import {sessionRoute} from "./library-auth.ts";
function setup(){const db=openLocalDb(":memory:");migrateLocalDb(db);return {db:db as unknown as AnansiDb,libraryToken:"owner"};}
async function rpc(env:any,key:string,method:string,params:any={}){const r=await handleMcp(env,new Request("https://library.test/mcp",{method:"POST",headers:{authorization:`Bearer ${key}`,accept:"application/json, text/event-stream","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}));const text=await r.text();const data=text.startsWith("event:")?JSON.parse(text.split("data: ")[1]!.split("\n")[0]!):JSON.parse(text);return data;}
async function call(env:any,key:string,name:string,args:any={}){const r=await rpc(env,key,"tools/call",{name,arguments:args});return r.result?.content ? JSON.parse(r.result.content[0].text):r;}
async function seed(db:AnansiDb){await upsertItems(db,[{source:"web",externalId:"fixture",url:"https://example.com/fixture",kind:"page",authorHandle:"fixture-author",body:"neighbouring vector indexes",savedAt:1,savedAtIsExact:true,metrics:{},media:[{kind:"image",originUrl:"https://example.com/a.png"}],links:[],raw:{}}]);return (await db.select().from(items))[0]!;}
test("API and OAuth tools honor write removal and revocation on next request; media and no delete",async()=>{
 for(const kind of ["api","app"] as const){const env=setup(),client=await createClient(env.db,"test",kind);let key=client.key;
 if(kind==="app"){key="anansi_at_fixture";await env.db.insert(oauthTokens).values({accessHash:createHash("sha256").update(key).digest("hex"),refreshHash:"fixture",clientId:"app",connectedClientId:client.id,scope:"library:read",resource:"https://library.test/mcp",accessExpiresAt:Math.floor(Date.now()/1000)+600,refreshExpiresAt:Math.floor(Date.now()/1000)+1200});}
 const item=await seed(env.db);
 let list=JSON.stringify(await rpc(env,key,"tools/list"));expect(list).not.toContain('"save_link"');expect(list).not.toContain('"delete');
 expect(JSON.stringify(await rpc(env,key,"tools/call",{name:"add_tag",arguments:{id:item.id,tag:"test"}}))).toContain("error");
 await setClientWrite(env.db,client.id,true);list=JSON.stringify(await rpc(env,key,"tools/list"));expect(list).toContain('"save_link"');expect(list).not.toContain('"delete');
 expect(await call(env,key,"add_tag",{id:item.id,tag:"test"})).toEqual({ok:true});
 expect(await call(env,key,"remove_tag",{id:item.id,tag:"test"})).toEqual({ok:true});
 expect(await call(env,key,"set_note",{id:item.id,note:"hello"})).toEqual({ok:true});expect(await call(env,key,"set_note",{id:item.id,note:""})).toEqual({ok:true});
 expect((await call(env,key,"save_link",{url:"https://example.com/new"})).inserted).toBe(1);
 for(const name of ["list_recent_saves","list_saved","list_author_saves"]){const catalog=await rpc(env,key,"tools/list");if(!catalog.result.tools.some((t:any)=>t.name===name))continue;const out=await call(env,key,name,name==="list_author_saves"?{handle:"fixture-author"}:{});expect(out.results.find((i:any)=>i.id===item.id).media_count).toBe(1);expect(out.results.find((i:any)=>i.id===item.id).media.length).toBe(1);}
 const search=await call(env,key,"search_saved",{query:"vector"});expect(search.search_mode).toBe("keyword");expect(search.fallback_reason).toBe("ai-off");expect(search.freshness.browserOffline).toBe(true);
 await setClientWrite(env.db,client.id,false);expect(JSON.stringify(await rpc(env,key,"tools/list"))).not.toContain('"save_link"');await updateClient(env.db,client.id);expect(await (await handleMcp(env,new Request("https://library.test/mcp",{headers:{authorization:`Bearer ${key}`}}))).status).toBe(401);
 }
});
test("permissions route requires same-origin owner session",async()=>{const env=setup(),c=await createClient(env.db,"test","api");const url=`https://library.test/api/clients/${c.id}/permissions`;
 for(const key of [c.key,"anansi_at_fake","owner"]){expect((await handleApi(env,new Request(url,{method:"PATCH",headers:{authorization:`Bearer ${key}`,origin:"https://library.test"},body:'{"write":true}'}))).status).toBe(401);}
 const login=await sessionRoute(env,new Request("https://library.test/api/session",{method:"POST",headers:{origin:"https://library.test"},body:'{"token":"owner"}'}));const cookie=login.headers.get("set-cookie")!.split(";")[0]!;
 for(const origin of ["https://evil.test","https://library.test"]){const r=await handleApi(env,new Request(url,{method:"PATCH",headers:{cookie,origin},body:'{"write":true}'}));expect(r.status).toBe(origin.includes("evil")?403:200);if(r.ok)expect((await r.json() as any).client.scopes).toBe("read,write");}
});
test("MCP semantic search shares budget, reports provider failure, cap, empty index",async()=>{const env=setup(),c=await createClient(env.db,"search","api"),row=await seed(env.db);await setAiSettings(env.db,{semanticSearchEnabled:true});const settings=await getAiSettings(env.db);const staged=await stageSemanticChunks(env.db,row,settings.embeddingModel,settings.semanticGeneration);await markSemanticChunksComplete(env.db,staged.chunks.map(c=>c.id),384);
 let calls=0;const runtime={...env,ai:{run:async()=>{calls++;return {data:[Array(384).fill(0.1)]};}},vectorize:{upsert:async()=>{},query:async()=>({matches:staged.chunks.map(c=>({id:c.id,score:1}))})}};
 const before=(await getAiSettings(env.db)).semanticBudgetUsed;const meaning=await call(runtime,c.key,"search_saved",{query:"unmatched"});expect(meaning.search_mode).toBe("meaning");expect(meaning.fallback_reason).toBeNull();expect(meaning.results[0].id).toBe(row.id);expect(calls).toBe(1);const used=(await getAiSettings(env.db)).semanticBudgetUsed-before;expect(used).toBe(1);
 const empty=await call({...runtime,vectorize:{...runtime.vectorize,query:async()=>({matches:[]})}},c.key,"search_saved",{query:"unmatched"});expect(empty.search_mode).toBe("keyword");expect(empty.fallback_reason).toBe("no-index");
 const failed=await call({...runtime,ai:{run:async()=>{throw Error("fake");}}},c.key,"search_saved",{query:"unmatched"});expect(failed.search_mode).toBe("keyword");expect(failed.fallback_reason).toBe("provider-unavailable");
 await setAiSettings(env.db,{semanticBudgetLimit:1});const cap=await call(runtime,c.key,"search_saved",{query:"unmatched"});expect(cap.search_mode).toBe("keyword");expect(cap.fallback_reason).toBe("quota");expect(calls).toBe(2);
});

test("MCP provider timeout returns keyword results",async()=>{const env=setup(),c=await createClient(env.db,"timeout","api");await seed(env.db);await setAiSettings(env.db,{semanticSearchEnabled:true});const result=await call({...env,ai:{run:()=>new Promise(()=>{})},vectorize:{upsert:async()=>{},query:async()=>({matches:[]})}},c.key,"search_saved",{query:"vector"});expect(result.search_mode).toBe("keyword");expect(result.fallback_reason).toBe("provider-unavailable");expect(result.results.length).toBe(1);},10000);
