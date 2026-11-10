import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openLocalDb, migrateLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { handleApi } from "./api.ts";
import { handleMcp } from "./mcp.ts";
import { authorizeClient, listClients, setClientWrite, updateClient } from "./clients.ts";
import { validRedirectUri, protectedResourceMetadata, authorizationServerMetadata } from "./oauth.ts";
import { oauthTokens } from "../../../../packages/db/src/schema.ts";
import { createClient } from "./clients.ts";
import { parseExtensionConfig, parseExtensionHeartbeat } from "@anansi/sources";
const origin = "https://library.test";
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
function setup() { const db = openLocalDb(":memory:"); migrateLocalDb(db); return {db:db as unknown as AnansiDb, libraryToken:"throwaway-owner"}; }
const request = (path:string, body?:unknown, headers:Record<string,string>={}) => new Request(origin+path,{method:body === undefined ? "GET":"POST",headers:{"content-type":"application/json",...headers},body:body === undefined ? undefined:JSON.stringify(body)});
async function connect() {
 const env=setup();
 const registered=await handleApi(env,request("/api/oauth/register",{client_name:"Test app",redirect_uris:["http://127.0.0.1:4567/callback"]}));
 expect(registered.status).toBe(201); const app=await registered.json() as {client_id:string;redirect_uris:string[]};
 expect(await listClients(env.db)).toHaveLength(0);
 const login=await handleApi(env,request("/api/auth/session",{token:env.libraryToken},{origin}));
 const cookie=login.headers.get("set-cookie")!.split(";")[0]!;
 const params={client_id:app.client_id,redirect_uri:app.redirect_uris[0],response_type:"code",code_challenge:challenge,code_challenge_method:"S256",resource:origin+"/mcp",state:"test"};
 const decision=await handleApi(env,request("/api/oauth/authorize",{params,allow:true},{origin,cookie}));
 const result=await decision.json() as {redirect:string}; expect(result.redirect).toBeString();
 const code=new URL(result.redirect).searchParams.get("code")!; expect(code).toBeString();
 const exchange=(values:Record<string,string>)=>handleApi(env,new Request(origin+"/api/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(values)}));
 const grant={grant_type:"authorization_code",client_id:app.client_id,redirect_uri:params.redirect_uri,code,code_verifier:verifier,resource:params.resource};
 return {env,app,cookie,params,exchange,grant};
}
test("OAuth discovery, consent, exchange, MCP initialize/list, rotation and immediate revoke",async()=>{
 const {env,exchange,grant}=await connect();
 expect(protectedResourceMetadata(origin).resource).toBe(origin+"/mcp"); expect(authorizationServerMetadata(origin).code_challenge_methods_supported).toEqual(["S256"]);
 const missing=await handleMcp(env,request("/mcp",{}));expect(missing.status).toBe(401);expect(missing.headers.get("www-authenticate")).toContain("resource_metadata");
 const response=await exchange(grant); const issued=await response.json() as {access_token:string;refresh_token:string};expect(response.status).toBe(200);expect(issued.access_token).toBeString();
 expect((await exchange(grant)).status).toBe(400);
 for(const method of ["initialize","tools/list"]){const response=await handleMcp(env,request("/mcp",{jsonrpc:"2.0",id:1,method,params:method === "initialize" ? {protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"oauth-test",version:"1"}}:{}},{authorization:`Bearer ${issued.access_token}`,accept:"application/json, text/event-stream"}));expect(response.status).toBe(200);expect(await response.text()).toContain("result");}
 for(const path of ["/api/items","/api/extension/config","/api/new-route"]){expect((await handleApi(env,request(path,undefined,{authorization:`Bearer ${issued.access_token}`}))).status).toBe(401);}
 const refresh={grant_type:"refresh_token",client_id:grant.client_id,refresh_token:issued.refresh_token,resource:grant.resource};
 const rotated=await exchange(refresh);expect(rotated.status).toBe(200);const next=await rotated.json() as {access_token:string;refresh_token:string};expect(next.refresh_token).not.toBe(issued.refresh_token);expect((await exchange(refresh)).status).toBe(400);
 expect((await authorizeClient(env,request("/mcp",{}, {authorization:`Bearer ${issued.access_token}`})))?.status).toBe(401);
 const [app]=await listClients(env.db);await updateClient(env.db,app!.id);
 expect((await authorizeClient(env,request("/mcp",{}, {authorization:`Bearer ${next.access_token}`})))?.status).toBe(401);
 expect((await exchange({...refresh,refresh_token:next.refresh_token})).status).toBe(400);
});
test("PKCE, redirect, audience, consent session and CSRF reject unsafe requests",async()=>{
 const {env,exchange,grant,params,cookie}=await connect();
 for(const changes of [{code_verifier:"b".repeat(64)},{redirect_uri:"https://evil.test/cb"},{resource:"https://evil.test/mcp"}]) expect((await exchange({...grant,...changes})).status).toBe(400);
 for(const headers of [{origin},{origin:"https://evil.test",cookie},{origin,authorization:`Bearer ${env.libraryToken}`}]) expect((await handleApi(env,request("/api/oauth/authorize",{params,allow:true},headers as unknown as Record<string,string>))).status).toBeOneOf([401,403]);
 const write = await handleApi(env,request("/api/oauth/authorize",{params:{...params,scope:"library:write"},allow:true},{origin,cookie}));
 expect((await write.json() as {redirect:string}).redirect).toContain("invalid_scope");
 for(const uri of ["javascript:alert(1)","data:text/html,bad","http://evil.test/cb","file:///tmp/a"])expect(validRedirectUri(uri)).toBe(false);
 for(const uri of ["https://app.test/cb","http://127.0.0.1/cb","cursor://oauth/cb"])expect(validRedirectUri(uri)).toBe(true);
});
test("extension contracts remain parseable and stored keys cannot approve OAuth",async()=>{
 const env=setup();
 for(const kind of ["extension","api"] as const){
  const client=await createClient(env.db,kind,kind);
  expect((await handleApi(env,request("/api/oauth/authorize",{params:{},allow:true},{origin,authorization:`Bearer ${client.key}`}))).status).toBe(401);
  if(kind === "extension"){
   const config=await handleApi(env,request("/api/extension/config",undefined,{authorization:`Bearer ${client.key}`}));expect(parseExtensionConfig(await config.json()).ok).toBe(true);
   const heartbeat={schemaVersion:1,installationId:crypto.randomUUID(),extensionVersion:"1.0.0",queue:{queued:0,uploading:0,retrying:0,failed:0},sources:{}};
   expect(parseExtensionHeartbeat(heartbeat).ok).toBe(true);
   const reply=await handleApi(env,request("/api/extension/heartbeat",heartbeat,{authorization:`Bearer ${client.key}`}));expect(reply.status).toBe(200);expect(await reply.json()).toMatchObject({ok:true,receivedAt:expect.any(Number),syncRequestedAt:null,platformSync:expect.any(Object)});
  }
 }
});
test("expired access tokens and tokens for another audience fail closed",async()=>{
 const {env,exchange,grant}=await connect();const response=await exchange(grant);const issued=await response.json() as {access_token:string};
 const req=()=>request("/mcp",{},{authorization:`Bearer ${issued.access_token}`});
 await env.db.update(oauthTokens).set({resource:"https://other.test/mcp"});expect((await authorizeClient(env,req()))?.status).toBe(401);
 await env.db.update(oauthTokens).set({resource:origin+"/mcp",accessExpiresAt:1});expect((await authorizeClient(env,req()))?.status).toBe(401);
});


test("consent says whether a reconnecting app already has write access",async()=>{
 const {env,params,cookie}=await connect();
 const describe=async()=>await (await handleApi(env,new Request(origin+"/api/oauth/authorize?"+new URLSearchParams(params),{headers:{cookie}}))).json() as {ok:boolean;name:string;write:boolean};
 expect(await describe()).toMatchObject({ok:true,name:"Test app",write:false});
 const [app]=await listClients(env.db);await setClientWrite(env.db,app!.id,true);
 expect((await describe()).write).toBe(true);
 await updateClient(env.db,app!.id);
 expect((await describe()).write).toBe(false);
});
