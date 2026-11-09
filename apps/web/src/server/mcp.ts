import { runPreviewPass } from "./link-preview.ts";
import type { MediaSource } from "./media.ts";
import { coordinateSearch } from "./search-coordinator.ts";
import { clientCanWrite } from "./clients.ts";
import { tagItems, removeItemTag, setItemNote, getItem, getLibraryRestore } from "@anansi/db";
import { canonicalizeWebUrl, webExternalId } from "@anansi/sources";
import { ingestCapture } from "./ingest.ts";
import type { AiBinding, VectorizeBinding } from "./ai.ts";
import { authorizeClient } from "./clients.ts";
import { mcpChallenge } from "./oauth.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAnansiServer } from "@anansi/mcp";
import { extensionHealth, requestPlatformSync, getSyncSettings, type AnansiDb } from "@anansi/db";

/** Stateless HTTP transport; authorization and tool grants are rebuilt per request. */
export interface McpEnv {
  db: AnansiDb;
  /** Absent means the endpoint is closed; a public library is opt-in. */
  token?: string;
  ai?: AiBinding;
  vectorize?: VectorizeBinding;
  media?: MediaSource;
  waitUntil?: (work:Promise<unknown>)=>void;
}

export async function handleMcp(env: McpEnv, request: Request): Promise<Response> {
  const denied = await authorizeClient(env, request);
  if (denied) {
    if (denied.status !== 401) return denied;
    const headers = new Headers(denied.headers);
    headers.set("www-authenticate", mcpChallenge(new URL(request.url).origin, request.headers.has("authorization")));
    return new Response(denied.body, { status: 401, headers });
  }

  const server = createAnansiServer(env.db, async () => {
    const now = Math.floor(Date.now()/1000);
    const [requested, health, settings] = await Promise.all([requestPlatformSync(env.db, now, "agent"), extensionHealth(env.db, now), getSyncSettings(env.db)]);
    return {browserOffline: health.connection !== "connected", platforms: Object.fromEntries(["x", "reddit", "github", "tiktok"].map(source => [source, {
      requested: requested.includes(source), browser: health.sources[source as keyof typeof health.sources] ?? null,
      ...(source === "github" ? {publicCheckedAt: settings.githubCheckedAt, publicError: settings.githubError} : {}),
    }]))};
  }, {
    search: options => coordinateSearch(env,options),
    ...(await clientCanWrite(env.db,request) ? {write: async (name:string,args:Record<string,unknown>) => {
      if (await authorizeClient(env,request) || !await clientCanWrite(env.db,request)) throw new Error("Write permission required");
      if ((await getLibraryRestore(env.db))?.status === "active") throw new Error("Library restore is in progress");
      if (name === "save_link") {
        const url=canonicalizeWebUrl(String(args.url));
        if (!url || !/^https?:/.test(url)) throw new Error("HTTP or HTTPS link required");
        const response=await ingestCapture(env.db,new Request(request.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[{source:"web",externalId:await webExternalId(url),url,kind:"page",body:"",savedAt:Math.floor(Date.now()/1000),savedAtIsExact:true,metrics:{},media:[],links:[],raw:{}}]})}));
        if (response.status < 300 && env.media && env.waitUntil) env.waitUntil(runPreviewPass(env.db,env.media));
        return response.body;
      }
      const id=String(args.id); if (!await getItem(env.db,id)) throw new Error("Item not found");
      if (name === "add_tag") await tagItems(env.db,[id],String(args.tag));
      else if (name === "remove_tag") await removeItemTag(env.db,id,String(args.tag));
      else if (name === "set_note") await setItemNote(env.db,id,String(args.note));
      return {ok:true};
    }} : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}
