import { describe, expect, test } from "bun:test";
import { isFetchableMediaUrl } from "./media.ts";

/**
 * The one URL the server fetches that a page chose.
 *
 * Platform CDNs were the only source of these until webpage capture arrived.
 * Now saving a hostile page can put any http(s) URL in front of that fetch, so
 * this is a request-forgery primitive pointed at whatever the server can reach.
 * The rule is the network location, not what the URL claims to serve.
 */
describe("isFetchableMediaUrl", () => {
  test("ordinary public CDN URLs are fine", () => {
    for (const url of [
      "https://pbs.twimg.com/media/abc.jpg",
      "https://p16-sign.tiktokcdn-us.com/cover~tplv.jpeg",
      "http://images.example.com/a.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(true);
    }
  });

  test("loopback is refused however it is spelled", () => {
    for (const url of [
      "http://127.0.0.1:8788/api/stats",
      "http://127.1.2.3/x.png",
      "http://localhost/x.png",
      "http://LOCALHOST/x.png",
      "http://[::1]/x.png",
      "http://0.0.0.0/x.png",
      "http://anything.localhost/x.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(false);
    }
  });

  test("private and link-local ranges are refused", () => {
    for (const url of [
      "http://10.0.0.5/x.png",
      "http://192.168.1.1/x.png",
      "http://172.16.0.1/x.png",
      "http://172.31.255.254/x.png",
      // The cloud metadata endpoint, the classic target.
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/x.png",
      "http://[fd00::1]/x.png",
      "http://[fe80::1]/x.png",
      "http://[::ffff:127.0.0.1]/x.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(false);
    }
  });

  test("public addresses inside near-miss ranges are still allowed", () => {
    // 172.32 is outside 172.16/12, and 11.x is not private at all.
    expect(isFetchableMediaUrl("http://172.32.0.1/x.png")).toBe(true);
    expect(isFetchableMediaUrl("http://11.0.0.1/x.png")).toBe(true);
  });

  test("internal-looking names are refused", () => {
    expect(isFetchableMediaUrl("http://db.internal/x.png")).toBe(false);
    expect(isFetchableMediaUrl("http://printer.local/x.png")).toBe(false);
  });

  test("only http and https, and never with credentials", () => {
    expect(isFetchableMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isFetchableMediaUrl("gopher://example.com/x")).toBe(false);
    expect(isFetchableMediaUrl("https://user:pass@example.com/x.png")).toBe(false);
    expect(isFetchableMediaUrl("not a url")).toBe(false);
  });
});

import { fetchPendingMedia, pinnedRequest, readBoundedImage, readMedia, workerMediaHostAllowed } from "./media.ts";
import { migrateLocalDb, openLocalDb } from "@anansi/db/local";
import { upsertItems, type AnansiDb } from "@anansi/db";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
describe("bounded media archival",()=>{
  test("a refused pinned connection is an ordinary rejected media request",async()=>{
    const probe=Bun.serve({port:0,fetch:()=>new Response("probe")});
    const port=probe.port;
    probe.stop(true);
    await expect(pinnedRequest(new URL(`http://media.example:${port}/image.png`),{address:"127.0.0.1",family:4},AbortSignal.timeout(2_000),http,https,Readable)).rejects.toHaveProperty("code","ECONNREFUSED");
  });
  test("active image types and mislabeled bytes are refused",async()=>{
    await expect(readBoundedImage(new Response("<svg/>",{headers:{"content-type":"image/svg+xml"}}))).rejects.toThrow("unsupported raster");
    await expect(readBoundedImage(new Response("<html/>",{headers:{"content-type":"image/png"}}))).rejects.toThrow("signature");
  });
  test("streaming size cap cancels an oversized body without buffering the remainder",async()=>{
    let cancelled=false;
    const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
    await expect(readBoundedImage(new Response(body,{headers:{"content-type":"image/png"}}))).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
  test("Worker trust list rejects lookalike domains and unsafe redirects",async()=>{
    expect(workerMediaHostAllowed("https://pbs.twimg.com/a")).toBe(true);
    expect(workerMediaHostAllowed("https://twimg.com.evil.test/a")).toBe(false);
    expect(workerMediaHostAllowed("https://evil-twimg.com/a")).toBe(false);
  });
  test("R2 binding receives a write with actual MIME and read preserves it",async()=>{
    const local=openLocalDb(":memory:");migrateLocalDb(local);const db=local as unknown as AnansiDb;
    await upsertItems(db,[{source:"x",externalId:"sink",url:"https://x.com/user/status/1",kind:"post",body:"image",savedAt:100,savedAtIsExact:true,metrics:{},links:[],raw:{},media:[{kind:"photo",originUrl:"https://pbs.twimg.com/media/example.png"}]}]);
    const writes:{key:string;type:string}[]=[];
    const previous=globalThis.fetch;
    globalThis.fetch=(async()=>new Response(png,{headers:{"content-type":"image/png"}})) as unknown as typeof fetch;
    try {
      const source={runtime:"worker" as const,bucket:{
        get:async()=>({body:new Response(png).body!,httpMetadata:{contentType:"image/png"}}),
        put:async(key:string,_bytes:ArrayBuffer,options?:{httpMetadata:{contentType:string}})=>{writes.push({key,type:options!.httpMetadata.contentType});},
      }};
      expect(await fetchPendingMedia(db,source)).toEqual({stored:1,failed:0});
      expect(writes[0]!.key).toEndWith(".png");expect(writes[0]!.type).toBe("image/png");
      const read=await readMedia(source,writes[0]!.key);
      expect(read.headers.get("content-type")).toBe("image/png");expect(read.headers.get("cache-control")).toContain("private");
      expect(await fetchPendingMedia(db,source)).toEqual({stored:0,failed:0});
    } finally {globalThis.fetch=previous;}
  });
  test("filesystem keys cannot escape the media root",async()=>{
    for (const key of ["../private.png","C:/private.png","ab\\cd\\x.png","/ab/cd/image.png"])
      expect((await readMedia({},key)).status).toBe(400);
  });
});
