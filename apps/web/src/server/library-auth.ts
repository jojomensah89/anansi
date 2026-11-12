import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export interface LibraryAuthEnv {
  libraryToken?: string;
  allowedOrigins?: string[];
}
const COOKIE = "anansi_session";
export const SESSION_TTL = 30 * 24 * 60 * 60;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers });
export function sameSecret(a: string, b: string): boolean {
  const left = createHmac("sha256", "anansi-comparison").update(a).digest();
  const right = createHmac("sha256", "anansi-comparison").update(b).digest();
  return timingSafeEqual(left, right);
}
export function allowedOrigin(env: LibraryAuthEnv, request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && (origin === new URL(request.url).origin || !!env.allowedOrigins?.includes(origin));
}
function sign(token: string, payload: string): string {
  return createHmac("sha256", token).update(`anansi-session-v1:${payload}`).digest("base64url");
}
export function authenticated(env: LibraryAuthEnv, request: Request): boolean {
  if (!env.libraryToken) return false;
  const bearer = request.headers.get("authorization");
  if (bearer) return sameSecret(bearer, `Bearer ${env.libraryToken}`);
  const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const [expires, nonce, signature, extra] = cookie.split(".");
  const now = Math.floor(Date.now() / 1000);
  return !extra && !!nonce && !!signature && Number(expires) > now && Number(expires) <= now + SESSION_TTL && sameSecret(signature, sign(env.libraryToken, `${expires}.${nonce}`));
}
export function authorizeLibrary(env: LibraryAuthEnv, request: Request): Response | null {
  if (!env.libraryToken) return json({ error: "library access is not configured" }, 503);
  if (!authenticated(env, request)) return json({ error: "unauthorized" }, 401);
  // An explicit bearer is not ambient browser authority. Cookies require CSRF protection.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.headers.has("authorization") && !allowedOrigin(env, request)) return json({ error: "origin is not allowed" }, 403);
  return null;
}
export async function sessionRoute(env: LibraryAuthEnv, request: Request, hasPasskey = false): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method === "GET") return json({ configured: !!env.libraryToken, authenticated: authenticated(env, request), hasPasskey }, 200, headers);
  if (!allowedOrigin(env, request)) return json({ error: "origin is not allowed" }, 403, headers);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const attrs = `; Path=/api; HttpOnly; SameSite=Strict${secure}`;
  if (request.method === "DELETE") return json({ configured: !!env.libraryToken, authenticated: false, hasPasskey }, 200, { ...headers, "set-cookie": `${COOKIE}=; Max-Age=0${attrs}` });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, headers);
  if (!env.libraryToken) return json({ error: "library access is not configured" }, 503, headers);
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "request too large" }, 413, headers);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return json({error:"request too large"},413,headers); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  const raw = new TextDecoder().decode(bytes);
  let body: { token?: unknown };
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid JSON" }, 400, headers); }
  if (!body || typeof body.token !== "string" || !sameSecret(body.token, env.libraryToken)) return json({ error: "unauthorized" }, 401, headers);
  return json({ configured: true, authenticated: true, hasPasskey }, 200, { ...headers, "set-cookie": sessionCookie(env, request) });
}
export function sessionCookie(env: LibraryAuthEnv, request: Request): string {
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_TTL}.${Buffer.from(randomBytes(24)).toString("base64url")}`;
  return `${COOKIE}=${payload}.${sign(env.libraryToken!, payload)}; Max-Age=${SESSION_TTL}; Path=/api; HttpOnly; SameSite=Strict${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function cookieAuthenticated(env: LibraryAuthEnv, request: Request): boolean {
  return !request.headers.has("authorization") && authenticated(env, request);
}
export function renewSession(env: LibraryAuthEnv, request: Request, response: Response): Response {
  if (!cookieAuthenticated(env, request) || response.headers.getSetCookie().some(cookie => cookie.startsWith(`${COOKIE}=`)) || response.status >= 400) return response;
  const expires = Number(request.headers.get("cookie")?.match(/(?:^|;\s*)anansi_session=(\d+)\./)?.[1]);
  if (expires - Math.floor(Date.now() / 1000) < SESSION_TTL / 2) {
    response = new Response(response.body, response);
    response.headers.append("set-cookie", sessionCookie(env, request));
    response.headers.set("cache-control", "no-store");
  }
  return response;
}
