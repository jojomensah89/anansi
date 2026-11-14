import {test, expect} from "bun:test";
import {parsePreview, safeAsset} from "@anansi/sources/link-preview";
import {fetchPreview, PREVIEW_BYTES, previewDelay, processLinkPreviews} from "./link-preview.ts";
import {isFetchableMediaUrl} from "./media.ts";
import {openLocalDb, migrateLocalDb} from "../../../../packages/db/src/local.ts";
import {sql} from "drizzle-orm";
const html = (s:string) => new Response(s,{headers:{"content-type":"text/html"}});
test("relative metadata, fallback selection and unsafe assets",()=>{
 expect(parsePreview('<meta property="og:image" content="/cover.png"><meta name="description" content="A &amp; B"><link rel="icon" href="icon.png">',"https://example.com/page")).toEqual({image:"https://example.com/cover.png",description:"A & B",siteName:"",favicon:"https://example.com/icon.png"});
 expect(parsePreview('<meta name="twitter:image" content="/tw.png">',"https://example.com").image).toBe("https://example.com/tw.png");
 expect(parsePreview("", "https://example.com").image).toBeUndefined();
 for (const url of ["javascript:alert(1)","data:image/png;base64,a"]) expect(safeAsset(url,"https://example.com")).toBeUndefined();
});
test("private hosts and normalized IP literals are refused",()=>{
 for(const host of ["localhost","foo.local","127.1","2130706433","10.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","100.64.0.1","[::1]","[fc00::1]","[::ffff:127.0.0.1]"]) expect(isFetchableMediaUrl(`http://${host}/`)).toBe(false);
 expect(isFetchableMediaUrl("https://example.com")).toBe(true);
});
test("redirect private destination is checked before transport",async()=>{
 let calls=0;
 await expect(fetchPreview("https://example.com",async()=>{calls++;return new Response(null,{status:302,headers:{location:"http://10.0.0.1"}});})).rejects.toThrow("refused");expect(calls).toBe(1);
});
test("redirect ceiling",async()=>{let calls=0;await expect(fetchPreview("https://example.com",async()=>{calls++;return new Response(null,{status:302,headers:{location:"/again"}});})).rejects.toThrow("redirect");expect(calls).toBe(4);});
test("size, content type and total timeout",async()=>{
 await expect(fetchPreview("https://example.com",async()=>html("x".repeat(PREVIEW_BYTES+1)))).rejects.toThrow("large");
 await expect(fetchPreview("https://example.com",async()=>new Response("image",{headers:{"content-type":"image/png"}}))).rejects.toThrow("HTML");
 await expect(fetchPreview("https://example.com",()=>new Promise(()=>{}),10)).rejects.toThrow("timeout");
 await expect(fetchPreview("https://example.com",async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("hi"));}}),{headers:{"content-type":"text/html"}}),10)).rejects.toThrow("timeout");
});
test("durable retries back off, stop at three, and no image is terminal",async()=>{
 const db=openLocalDb(":memory:");migrateLocalDb(db);
 await db.run(sql`INSERT INTO items(id,source,external_id,url,kind,saved_at,raw) VALUES('p','web','p','https://example.com','page',1,'{}')`);
 let calls=0;const fail=async()=>{calls++;throw new Error("fixture");};
 await processLinkPreviews(db,"local",fail,1000);await processLinkPreviews(db,"local",fail,1001);expect(calls).toBe(1);
 await processLinkPreviews(db,"local",fail,1300);await processLinkPreviews(db,"local",fail,1900);await processLinkPreviews(db,"local",fail,9999);expect(calls).toBe(3);
 expect([1,2,3].map(previewDelay)).toEqual([300,600,1200]);
 await db.run(sql`DELETE FROM link_preview_jobs`);
 await processLinkPreviews(db,"local",async()=>html('<meta name="description" content="Useful excerpt">'),10000);
 expect((await db.all<{done:number}>(sql`SELECT done FROM link_preview_jobs`))[0]!.done).toBe(1);
 await processLinkPreviews(db,"local",fail,20000);expect(calls).toBe(3);
});


test("Worker DNS refuses private resolved addresses without fetching the page", async()=>{
 const {publicFetch}=await import("./public-fetch.ts");
 let calls=0;
 const request=(async()=>{calls++;return Response.json({Status:0,Answer:[{type:1,data:"10.0.0.1"}]});}) as unknown as typeof fetch;
 await expect(publicFetch(new URL("https://example.com"),new AbortController().signal,"worker",request)).rejects.toThrow("DNS destination");
 expect(calls).toBe(1);
});

test("shared budget charges both DNS families and every redirect hop, refuses overflow", async()=>{
 const {FetchBudget}=await import("./fetch-budget.ts");
 const {publicFetch}=await import("./public-fetch.ts");
 const budget=new FetchBudget(12);
 let calls=0;
 const request=(async(input: string | URL)=>{calls++;return String(input).includes("dns-query") ? Response.json({Status:0,Answer:[{type:1,data:"93.184.216.34"}]}) : new Response(null,{status:302,headers:{location:"/next"}});}) as unknown as typeof fetch;
 await expect(fetchPreview("https://example.com",(u,s)=>publicFetch(u,s,"worker",request,budget))).rejects.toThrow("redirect");
 expect(calls).toBe(12);expect(budget.used).toBe(12);expect(budget.canStart()).toBe(false);
 await expect(publicFetch(new URL("https://example.com"),new AbortController().signal,"worker",request,budget)).rejects.toThrow("budget");expect(calls).toBe(12);
});
test("batch claims several pages and leaves insufficient reserve untouched",async()=>{
 const {FetchBudget}=await import("./fetch-budget.ts");
 const db=openLocalDb(":memory:");migrateLocalDb(db);
 for(let i=0;i<20;i++) await db.run(sql`INSERT INTO items(id,source,external_id,url,kind,saved_at,raw) VALUES(${String(i)},'web',${String(i)},'https://example.com','page',1,'{}')`);
 const budget=new FetchBudget();let pages=0;
 await processLinkPreviews(db,"worker",async()=>{pages++;return html("");},1000,budget);
 expect(pages).toBe(10);expect(budget.used).toBe(30);
 const expired=new FetchBudget(40,0);await processLinkPreviews(db,"worker",async()=>{throw new Error("must not run");},1000,expired);expect(expired.used).toBe(0);
});
