import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, lt, gt, or } from "drizzle-orm";
import { connectedClients as clients, clientSecurity, oauthTokens } from "../../../../packages/db/src/schema.ts";
import type { AnansiDb } from "@anansi/db";
import { sameSecret } from "./library-auth.ts";
export const CAPTURE_ROUTES = ["POST /api/extension/retire-self", "POST /api/ingest", "POST /api/extension/heartbeat", "GET /api/extension/config", "GET /api/extension/known-ids", "GET /api/extension/stats"] as const;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const now = () => Math.floor(Date.now()/1000);
export async function createClient(db: AnansiDb, name: string, kind: "extension" | "api" | "pairing" | "app") {
 if (!name.trim() || name.length > 100) throw new Error("Name must contain 1 to 100 characters");
 const key = `anansi_${Buffer.from(randomBytes(32)).toString("base64url")}`;
 const row = {id: randomUUID(), name: name.trim(), kind, scopes: kind === "api" || kind === "app" ? "read" : "capture", keyHash: hash(key), createdAt: now()};
 await db.insert(clients).values(row);
 return {id: row.id, key};
}
export async function listClients(db: AnansiDb) {
 return db.select({id: clients.id, kind: clients.kind, name: clients.name, scopes: clients.scopes, createdAt: clients.createdAt, lastUse: clients.lastUse, revokedAt: clients.revokedAt}).from(clients);
}
export async function retired(db: AnansiDb) { return !!(await db.select().from(clientSecurity).where(eq(clientSecurity.id,1)))[0]?.retiredAt; }
export async function retireLegacy(db: AnansiDb) { await db.insert(clientSecurity).values({id:1,retiredAt:now()}).onConflictDoUpdate({target:clientSecurity.id,set:{retiredAt:now()}}); }
export async function updateClient(db: AnansiDb, id: string, name?: string) {
 if (name !== undefined && (!name.trim() || name.length > 100)) throw new Error("Invalid name");
 await db.update(clients).set(name === undefined ? {revokedAt:now()} : {name:name.trim()}).where(eq(clients.id,id));
}
export async function redeemPairing(db: AnansiDb, code: string) {
 const rows = await db.update(clients).set({revokedAt:now(),lastUse:now()}).where(and(eq(clients.keyHash,hash(code)),eq(clients.kind,"pairing"),isNull(clients.revokedAt),lt(clients.createdAt,now()+1),gt(clients.createdAt,now()-301))).returning();
 const row=rows[0];
 if (!row || now()-row.createdAt > 300) return null;
 return createClient(db,row.name,"extension");
}
export async function authorizeClient(env: {db: AnansiDb; ingestToken?: string; token?: string}, request: Request): Promise<Response | null> {
 const route = `${request.method} ${new URL(request.url).pathname.replace(/\/+$/, "")}`;
 const capture = (CAPTURE_ROUTES as readonly string[]).includes(route);
 const mcp = new URL(request.url).pathname.replace(/[/]+$/, "") === "/mcp";
 const key = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
 const denied = () => Response.json({error:"unauthorized"},{status:401});
 // /mcp always answers 401 without a credential: that is how an OAuth client learns to sign in.
 if (!key) return capture && !env.ingestToken?.trim() ? Response.json({error:"access is not configured"},{status:503}) : denied();
 if (!capture && !mcp) return denied();
 if (!mcp && key.startsWith("anansi_at_")) return denied();
 const digest=hash(key);
 if (mcp && key.startsWith("anansi_at_")) return await authorizeOAuthToken(env.db,digest,new URL(request.url).origin) ? null : denied();
 const row=(await env.db.select().from(clients).where(eq(clients.keyHash,digest)))[0];
 if (row) {
  if (!sameSecret(digest,row.keyHash) || row.revokedAt !== null || (capture ? row.kind !== "extension" || row.scopes !== "capture" : row.kind !== "api" || row.scopes !== "read")) return denied();
  if (row.lastUse === null || now()-row.lastUse >= 300) await env.db.update(clients).set({lastUse:now()}).where(and(eq(clients.id,row.id),or(isNull(clients.lastUse),lt(clients.lastUse,now()-299))));
  return null;
 }
 const legacy=capture ? env.ingestToken : env.token;
 if (!legacy?.trim()) return capture ? Response.json({error:"access is not configured"},{status:503}) : denied();
 return sameSecret(key,legacy) && !await retired(env.db) ? null : denied();
}

/** Checked against the app's row on every request, so revoking takes effect immediately. */
async function authorizeOAuthToken(db: AnansiDb, accessHash: string, origin: string) {
 const [row]=await db.select({resource:oauthTokens.resource,expires:oauthTokens.accessExpiresAt,id:clients.id,kind:clients.kind,revokedAt:clients.revokedAt,lastUse:clients.lastUse})
  .from(oauthTokens).innerJoin(clients,eq(clients.id,oauthTokens.connectedClientId)).where(eq(oauthTokens.accessHash,accessHash));
 if (!row || row.kind !== "app" || row.revokedAt !== null || row.expires <= now() || row.resource !== `${origin}/mcp`) return false;
 if (row.lastUse === null || now()-row.lastUse >= 300) await db.update(clients).set({lastUse:now()}).where(and(eq(clients.id,row.id),or(isNull(clients.lastUse),lt(clients.lastUse,now()-299))));
 return true;
}

export async function retireSelf(db: AnansiDb, request: Request) {
 const key=request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
 if (!key) return false;
 const rows=await db.update(clients).set({revokedAt:now()}).where(and(eq(clients.keyHash,hash(key)),eq(clients.kind,"extension"),eq(clients.scopes,"capture"),isNull(clients.revokedAt))).returning({id:clients.id});
 return rows.length === 1;
}
