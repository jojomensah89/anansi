import { randomBytes } from "node:crypto";
import type { Source } from "../core/item.ts";
import { dataPath, ensureDir } from "../store/files.ts";
import { loadCheckpoint, saveCheckpoint, zeroItemRegression } from "../store/checkpoint.ts";

/**
 * The receiving half of the capture path.
 *
 * The browser makes the request, because that is where the session already
 * is. This listens on loopback for the raw payloads it sends. Nobody types a
 * credential anywhere: `credentials: "include"` in the page uses the cookie
 * jar the browser already holds, and what crosses to this server is the
 * untouched bookmark payload — never a cookie.
 *
 * It is also, deliberately, the same shape as the eventual `/api/ingest`:
 * accept raw, parse server-side. When the extension replaces the snippet,
 * only the sender changes.
 */

export interface IngestOptions {
  source: Source;
  port?: number;
  /** Called once the page reports it is finished. */
  onDone: (stats: { pages: number; items: number }) => Promise<void>;
}

export interface IngestServer {
  url: string;
  token: string;
  finished: Promise<void>;
  stop(): void;
}

interface IngestBody {
  source?: string;
  page?: number;
  raw?: unknown;
  done?: boolean;
  pages?: number;
  items?: number;
}

export async function startIngestServer(opts: IngestOptions): Promise<IngestServer> {
  const port = opts.port ?? 8787;
  const token = randomBytes(16).toString("hex");
  const runId = Date.now();
  const dir = dataPath("raw", opts.source);
  await ensureDir(dir);

  let received = 0;
  let resolveFinished!: () => void;
  let rejectFinished!: (err: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });

  const cors = (extra: Record<string, string> = {}): Record<string, string> => ({
    // The page posting here is x.com; nothing else has any reason to.
    "access-control-allow-origin": "https://x.com",
    "access-control-allow-headers": "content-type, x-anansi-token",
    "access-control-allow-methods": "POST, OPTIONS",
    // Chrome gates public -> private-network requests behind this.
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    ...extra,
  });

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
      if (url.pathname === "/health") {
        return new Response("ok", { headers: cors() });
      }
      if (url.pathname !== "/ingest" || req.method !== "POST") {
        return new Response("not found", { status: 404, headers: cors() });
      }
      if (req.headers.get("x-anansi-token") !== token) {
        return new Response("bad token", { status: 403, headers: cors() });
      }

      let body: IngestBody;
      try {
        body = (await req.json()) as IngestBody;
      } catch {
        return new Response("bad json", { status: 400, headers: cors() });
      }

      if (body.done) {
        const stats = { pages: body.pages ?? received, items: body.items ?? 0 };
        // Reply before finalizing so the page's console gets a clean answer.
        queueMicrotask(() => {
          opts.onDone(stats).then(resolveFinished, rejectFinished);
        });
        return new Response(`received ${received} pages`, { headers: cors() });
      }

      if (body.raw === undefined || typeof body.page !== "number") {
        return new Response("expected { page, raw } or { done: true }", {
          status: 400,
          headers: cors(),
        });
      }

      const name = `page-${runId}-${String(body.page).padStart(4, "0")}.json`;
      await Bun.write(`${dir}/${name}`, JSON.stringify(body.raw));
      received++;
      process.stdout.write(`  received page ${body.page} (${received} total)\r`);

      return new Response("ok", { headers: cors() });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    finished,
    stop: () => server.stop(true),
  };
}

/** Append the run to the ledger the zero-item alarm reads. */
export async function recordRun(
  source: Source,
  stats: { pages: number; items: number },
  startedAt: number,
): Promise<boolean> {
  const checkpoint = await loadCheckpoint(source);
  checkpoint.runs.push({
    startedAt,
    finishedAt: Date.now(),
    pages: stats.pages,
    items: stats.items,
    status: "ok",
    endpointSource: "browser",
  });
  await saveCheckpoint(checkpoint);
  return zeroItemRegression(checkpoint);
}
