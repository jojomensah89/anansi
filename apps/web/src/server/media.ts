import { join } from "node:path";
import { claimMediaJobs, completeMediaJob, failMediaJob } from "@anansi/db";
import type { AnansiDb } from "@anansi/db";

export interface MediaSource {
  bucket?: {
    get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
    put?(key: string, bytes: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  };
  dir?: string;
  put?: (key: string, bytes: ArrayBuffer, contentType?: string) => Promise<void>;
  runtime?: "worker" | "local";
}
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const EXT_TYPES = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]));
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
// Cloudflare fetch cannot pin resolved addresses. Restrict that transport to
// established provider CDNs; arbitrary webpage media uses pinned local fetch.
const WORKER_CDNS = ["twimg.com", "redd.it", "redditmedia.com", "githubusercontent.com", "tiktokcdn.com", "tiktokcdn-us.com"];
export function workerMediaHostAllowed(value: string): boolean {
  try { const host = new URL(value).hostname.toLowerCase(); return WORKER_CDNS.some(domain => host === domain || host.endsWith(`.${domain}`)); }
  catch { return false; }
}
export function isPublicAddress(host: string): boolean {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1]!,16), low = parseInt(mapped[2]!,16);
      return isPublicAddress([high>>8,high&255,low>>8,low&255].join("."));
    }
    // Only ordinary global unicast; refuse special transition mechanisms.
    return /^[23][0-9a-f]{0,3}:/.test(host) && !/^2002:/.test(host) && !/^2001:(?:db8|0):/.test(host);
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = parts as [number,number,number,number];
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
export function isFetchableMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["https:","http:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host.includes(":") || /^[\d.]+$/.test(host)) return isPublicAddress(host);
    return host.includes(".") && !host.endsWith(".") && !["localhost","local","internal","home","lan"].some(s => host===s || host.endsWith(`.${s}`));
  } catch { return false; }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("media request timed out");
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error("media request timed out"));
    signal.addEventListener("abort",abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
}
/** DNS validation and the connection share the same address, closing rebinding. */
async function localFetch(url: URL, signal: AbortSignal): Promise<Response> {
  const [{ lookup }, http, https, { Readable }, { isIP }] = await Promise.all([
    import("node:dns/promises"), import("node:http"), import("node:https"), import("node:stream"), import("node:net"),
  ]);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await abortable(lookup(hostname, {all:true}), signal);
  if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) throw new Error("refused non-public media destination");
  if (signal.aborted) throw new Error("media request timed out");
  const address = addresses[0]!;
  return pinnedRequest(url,address,signal,http,https,Readable);
}

/**
 * Connect to the address already approved by localFetch while retaining the
 * original Host header and TLS server name. Passing a custom lookup callback
 * through Bun's node:https compatibility layer can raise an uncaught socket
 * error when every address refuses the connection on Windows.
 */
export function pinnedRequest(
  url: URL,
  address: {address:string;family:number},
  signal: AbortSignal,
  http: typeof import("node:http"),
  https: typeof import("node:https"),
  Readable: typeof import("node:stream").Readable,
): Promise<Response> {
  return new Promise((resolve,reject) => {
    const request = (url.protocol === "https:" ? https.request : http.request)(url, {
      method:"GET",
      signal,
      hostname:address.address,
      family:address.family,
      port:url.port || undefined,
      path:`${url.pathname}${url.search}`,
      headers:{host:url.host},
      ...(url.protocol === "https:" ? {servername:url.hostname} : {}),
    }, response => {
      const headers = new Headers();
      for (const [name,value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name,Array.isArray(value)?value.join(", "):value);
      resolve(new Response(Readable.toWeb(response) as unknown as ReadableStream, {status:response.statusCode??502,headers}));
    });
    request.once("error",reject);
    request.end();
  });
}
export async function readBoundedImage(response: Response): Promise<{bytes:ArrayBuffer;contentType:string}> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`media HTTP ${response.status}`); }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES[contentType]) { await response.body?.cancel(); throw new Error("unsupported raster image type"); }
  if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) { await response.body?.cancel(); throw new Error("media too large"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty media response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA_BYTES) throw new Error("media too large");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
  finally { reader.releaseLock(); }
  if (!size) throw new Error("empty media image");
  const bytes = new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  // Reject active or mislabeled payloads instead of trusting the MIME claim.
  const ascii = (start:number,end:number) => String.fromCharCode(...bytes.slice(start,end));
  const valid = contentType === "image/jpeg" ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
    : contentType === "image/png" ? bytes[0]===137 && ascii(1,4)==="PNG" && bytes[4]===13 && bytes[5]===10 && bytes[6]===26 && bytes[7]===10
    : contentType === "image/gif" ? ["GIF87a","GIF89a"].includes(ascii(0,6))
    : contentType === "image/webp" ? ascii(0,4)==="RIFF" && ascii(8,12)==="WEBP"
    : ascii(4,8)==="ftyp" && ["avif","avis"].includes(ascii(8,12));
  if (!valid) throw new Error("image signature does not match content type");
  return {bytes:bytes.buffer,contentType};
}
export async function fetchThumbnail(target: string, runtime: "local" | "worker" = "local"): Promise<{bytes:ArrayBuffer;contentType:string}> {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try {
    let url = new URL(target);
    for (let redirects=0;redirects<=3;redirects++) {
      if (!isFetchableMediaUrl(url.href)) throw new Error("refused media url");
      if (runtime === "worker" && !workerMediaHostAllowed(url.href)) throw new Error("Worker media host is not in the trusted CDN list; use local media sync");
      const response = runtime === "worker" ? await fetch(url,{redirect:"manual",signal:controller.signal}) : await localFetch(url,controller.signal);
      if (response.status >=300 && response.status<400) {
        const location=response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects===3) throw new Error("too many media redirects");
        url = new URL(location,url);
      } else return await readBoundedImage(response);
    }
    throw new Error("too many media redirects");
  } finally { clearTimeout(timeout); }
}
export async function readMedia(source: MediaSource, key: string): Promise<Response> {
  // Only generated object keys are accepted; no drive paths, traversal or alternate separators.
  if (!/^[a-zA-Z0-9_-]{2}\/[a-zA-Z0-9_-]{2}\/[a-zA-Z0-9_-]+\.(?:webp|jpg|jpeg|png|gif|avif)$/.test(key)) return new Response("bad key",{status:400});
  const inferred = EXT_TYPES[key.split(".").at(-1)!] ?? "image/jpeg";
  const headers = {"content-type":inferred,"cache-control":"private, no-store","x-content-type-options":"nosniff"};
  if (source.bucket) {
    const object = await source.bucket.get(key);
    if (!object) return new Response("not found",{status:404});
    if (object.httpMetadata?.contentType && TYPES[object.httpMetadata.contentType]) headers["content-type"]=object.httpMetadata.contentType;
    return new Response(object.body,{headers});
  }
  if (source.dir) {
    const file=Bun.file(join(source.dir,key));
    if (!(await file.exists())) return new Response("not found",{status:404});
    return new Response(file,{headers});
  }
  return new Response("media is not configured",{status:503});
}
export async function fetchPendingMedia(db: AnansiDb, source: MediaSource, limit=4): Promise<{stored:number;failed:number}> {
  if (!source.put && !source.bucket?.put && !source.dir) return {stored:0,failed:0};
  const rows=await claimMediaJobs(db,limit);
  let stored=0,failed=0;
  await Promise.all(rows.map(async row=>{
    try {
      const {bytes,contentType}=await fetchThumbnail(variant(row.originUrl),source.runtime ?? (source.bucket ? "worker":"local"));
      const flat=row.id.replace(/-/g,"");
      const key=`${flat.slice(0,2)}/${flat.slice(2,4)}/${flat}-${row.token.replace(/-/g, "")}.${TYPES[contentType]}`;
      if (source.put) await source.put(key,bytes,contentType);
      else if (source.bucket?.put) await source.bucket.put(key,bytes,{httpMetadata:{contentType}});
      else if (source.dir) {
        const {mkdir}=await import("node:fs/promises");
        const {dirname}=await import("node:path");
        const path=join(source.dir,key);
        await mkdir(dirname(path),{recursive:true});
        await Bun.write(path,bytes);
      }
      await completeMediaJob(db,row.id,row.token,key);
      stored++;
    } catch (error) {
      await failMediaJob(db,row.id,row.token,row.attempts,error instanceof Error?error.message:"media fetch failed");
      failed++;
    }
  }));
  return {stored,failed};
}
function variant(originUrl: string): string {
  try {
    const url=new URL(originUrl);
    if (url.hostname!=="pbs.twimg.com") return originUrl;
    url.pathname=url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i,"");
    url.searchParams.set("format","webp");url.searchParams.set("name","small");
    return url.href;
  } catch { return originUrl; }
}
