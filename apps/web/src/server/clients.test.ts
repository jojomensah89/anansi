import { expect, test } from "bun:test";
import { openLocalDb, migrateLocalDb } from "@anansi/db/local";
import type { AnansiDb } from "@anansi/db";
import { connectedClients } from "../../../../packages/db/src/schema.ts";
import { authorizeClient, CAPTURE_ROUTES, createClient, listClients, redeemPairing, retireLegacy, updateClient } from "./clients.ts";
import { handleApi, ROUTES } from "./api.ts";
import { handleMcp } from "./mcp.ts";
import { sessionRoute } from "./library-auth.ts";
function setup() {const local=openLocalDb(":memory:");migrateLocalDb(local);return {db:local as unknown as AnansiDb,libraryToken:"owner-test",ingestToken:"legacy-test",token:"legacy-test"};}
const req=(path:string,key:string,method="GET",body?:unknown,origin?:string)=>new Request(`https://library.test${path}`,{method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json",...(origin ? {origin}: {})},body:body === undefined ? undefined : JSON.stringify(body)});
test("capture authorization enumerates the complete route table and defaults deny",async()=>{
 const env=setup(), client=await createClient(env.db,"Browser","extension");
 for(const route of ROUTES){const path=typeof route.path === "string" ? route.path : route.path.source.includes("extension") ? "/api/extension/sources/x" : "/api/items/example";const allowed=(CAPTURE_ROUTES as readonly string[]).includes(`${route.method} ${path}`) || `${route.method} ${path}` === "POST /api/extension/sources/x";expect(await authorizeClient(env,req(path,client.key,route.method))).toEqual(allowed ? null : expect.any(Response));}
 // The popup's switch is the one parameterised capture route; its library twin stays owner-only.
 expect(await authorizeClient(env,req("/api/extension/sources/x",client.key,"GET"))).toEqual(expect.any(Response));
 expect(await authorizeClient(env,req("/api/sources/x",client.key,"POST"))).toEqual(expect.any(Response));
 expect((await handleApi(env,req("/api/items",client.key))).status).toBe(401);
 expect((await handleMcp(env,req("/mcp",client.key,"POST",{}))).status).toBe(401);
 expect((await authorizeClient(env,req("/api/extension/new-route",client.key)))?.status).toBe(401);
});
test("all stored key kinds revoke immediately, plaintext is never stored or listed",async()=>{
 const env=setup();for(const kind of ["extension","api","pairing"] as const){const client=await createClient(env.db,kind,kind);expect(JSON.stringify(await env.db.select().from(connectedClients))).not.toContain(client.key);expect(JSON.stringify(await listClients(env.db))).not.toContain(client.key);await updateClient(env.db,client.id);if(kind === "pairing")expect(await redeemPairing(env.db,client.key)).toBeNull();else expect((await authorizeClient(env,req(kind === "api" ? "/mcp" : "/api/extension/config",client.key)))?.status).toBe(401);}
});
test("API key initializes MCP end to end and cannot obtain write permissions",async()=>{
 const env=setup(),client=await createClient(env.db,"Script","api");
 const request=req("/mcp",client.key,"POST",{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"test",version:"1"}}});request.headers.set("accept","application/json, text/event-stream");
 const response=await handleMcp(env,request);expect(response.status).toBe(200);expect(await response.text()).toContain("serverInfo");
 const write=req("/mcp",client.key,"POST",{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"set_item_note",arguments:{id:"example",note:"bad"}}});write.headers.set("accept","application/json, text/event-stream");
 const rejected=await handleMcp(env,write);expect(await rejected.text()).toContain("error");
 expect((await handleApi(env,req("/api/clients",env.libraryToken,"POST",{kind:"api",name:"Write",scopes:["write"]},"https://library.test"))).status).toBe(400);
 expect((await handleApi(env,req("/api/items/anything/note",client.key,"PATCH",{note:"bad"}))).status).toBe(401);
});
test("legacy credentials work narrowly until explicit retirement",async()=>{const env=setup();expect(await authorizeClient(env,req("/api/extension/config",env.ingestToken))).toBeNull();expect(await authorizeClient(env,req("/mcp",env.token,"POST",{}))).toBeNull();expect((await authorizeClient(env,req("/api/items",env.token)))?.status).toBe(401);await retireLegacy(env.db);expect((await authorizeClient(env,req("/mcp",env.token,"POST",{})))?.status).toBe(401);expect((await authorizeClient(env,req("/api/extension/config",env.token)))?.status).toBe(401);});
test("pairing is single use; origin and subframe page requests cannot obtain keys",async()=>{const env=setup(),code=await createClient(env.db,"Browser","pairing");for(const origin of ["https://evil.test","https://library.test"]){const request=req("/api/connect/redeem","","POST",{code:code.key},origin);expect((await handleApi(env,request)).status).toBe(403);}const issued=await redeemPairing(env.db,code.key);expect(issued?.key).toBeDefined();expect(await redeemPairing(env.db,code.key)).toBeNull();});
test("cookie authenticated create/revoke reject CSRF",async()=>{const env=setup();const login=await sessionRoute(env,req("/api/auth/session","","POST",{token:env.libraryToken},"https://library.test"));const cookie=login.headers.get("set-cookie")!.split(";")[0]!;for(const [path,method] of [["/api/clients","POST"],["/api/clients/test","DELETE"]]){const request=new Request(`https://library.test${path}`,{method,headers:{cookie,origin:"https://evil.test","content-type":"application/json"},body:method === "POST" ? JSON.stringify({kind:"api",name:"bad"}) : undefined});expect((await handleApi(env,request)).status).toBe(403);}});

test("retirement preserves cookie sign-in but disables master bearer library access",async()=>{const env=setup();await retireLegacy(env.db);expect((await handleApi(env,req("/api/items",env.libraryToken))).status).toBe(401);const response=await sessionRoute(env,req("/api/auth/session","","POST",{token:env.libraryToken},"https://library.test"));expect(response.status).toBe(200);const cookie=response.headers.get("set-cookie")!.split(";")[0]!;expect((await handleApi(env,new Request("https://library.test/api/clients",{headers:{cookie}}))).status).toBe(200);});

test("a real extension can redeem a code with the Origin header browsers send", async () => {
	const env = setup();
	const code = await createClient(env.db, "Browser", "pairing");
	const response = await handleApi(env, new Request("https://library.test/api/connect/redeem", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "chrome-extension://klebnaplemojhjlhpdpcgliemaehcilo" },
		body: JSON.stringify({ code: code.key }),
	}));
	expect(response.status).toBe(200);
	const issued = (await response.json()) as { key: string };
	expect(await authorizeClient(env, req("/api/extension/config", issued.key))).toBeNull();
	for (const origin of ["null", "chrome-extension://bad/path", "https://chrome-extension.evil.test"]) {
		const again = await createClient(env.db, "Browser", "pairing");
		const refused = await handleApi(env, new Request("https://library.test/api/connect/redeem", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ code: again.key }),
		}));
		expect(refused.status).toBe(403);
	}
});

test("an API key reaches MCP with or without a trailing slash", async () => {
	const env = setup();
	const client = await createClient(env.db, "Script", "api");
	expect(await authorizeClient(env, req("/mcp/", client.key, "POST", {}))).toBeNull();
});

test("retire-self refuses non-extension credentials and only revokes its own client",async()=>{
 const env=setup(), own=await createClient(env.db,"Own","extension"), other=await createClient(env.db,"Other","extension");
 for(const kind of ["api","pairing"] as const){const c=await createClient(env.db,kind,kind);expect((await handleApi(env,req("/api/extension/retire-self",c.key,"POST"))).status).toBe(401);}
 expect((await handleApi(env,req("/api/extension/retire-self",env.ingestToken,"POST"))).status).toBe(401);
 expect((await handleApi(env,req("/api/extension/retire-self",own.key,"POST"))).status).toBe(200);
 expect((await handleApi(env,req("/api/extension/retire-self",own.key,"POST"))).status).toBe(401);
 expect(await authorizeClient(env,req("/api/extension/config",other.key))).toBeNull();
 expect(await authorizeClient(env,req("/api/extension/config",env.ingestToken))).toBeNull();
});
test("redemption marker distinguishes dismiss and unrelated clients",async()=>{
 const env=setup(),a=await createClient(env.db,"A","pairing"),b=await createClient(env.db,"B","pairing");
 await updateClient(env.db,b.id);await createClient(env.db,"Other","extension");
 let rows=await listClients(env.db);expect(rows.find(c=>c.id===a.id)?.lastUse).toBeNull();expect(rows.find(c=>c.id===b.id)?.lastUse).toBeNull();
 await redeemPairing(env.db,a.key);rows=await listClients(env.db);expect(rows.find(c=>c.id===a.id)?.lastUse).toBeNumber();
});
