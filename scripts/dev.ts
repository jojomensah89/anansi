/**
 * The whole thing, locally, with one command.
 *
 * Anansi runs as two processes in development and that is not going away:
 * Vite's dev SSR runs under Node, which cannot load `bun:sqlite`, so the UI
 * cannot reach the library itself. The API is a separate Bun process and the
 * browser talks to it directly. That is fine — but remembering two commands,
 * two ports and an env var every time is not, and getting one of them subtly
 * wrong is worse than forgetting it outright.
 *
 * Three specific mistakes this exists to make impossible:
 *
 *   1. Starting the API from apps/web, where its default relative db path
 *      resolves to apps/web/data/anansi.db — a file SQLite happily creates
 *      empty, so the library appears to have lost everything.
 *   2. Leaving an older API on the port. The new one exits, the old one keeps
 *      answering with the routes it was built with, and the resulting bug hunt
 *      is spent in entirely the wrong file.
 *   3. Having no ingest token, so the extension gets a 503 from a server that
 *      otherwise looks healthy.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const API_PORT = Number(process.env.PORT ?? 8788);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3001);

/** Absolute, always. This is mistake (1), and it costs a real library. */
const DB_PATH = process.env.ANANSI_DB_PATH ?? join(ROOT, "data", "anansi.db");
const MEDIA_DIR = process.env.ANANSI_MEDIA_DIR ?? join(ROOT, "data", "media");
const INGEST_TOKEN_FILE = join(ROOT, "data", "dev-ingest-token");
const LIBRARY_TOKEN_FILE = join(ROOT, "data", "dev-library-token");

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

/**
 * Free, or not.
 *
 * Binding is the only answer that is actually true — a port can be held by
 * something that answers nothing, and something that answers can be behind a
 * proxy rather than on the port itself.
 */
async function portIsFree(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({ port, fetch: () => new Response("") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Whether whatever holds the port at least looks like this API. */
async function looksLikeAnansi(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: unknown; authenticated?: unknown };
    return typeof body.configured === "boolean" && typeof body.authenticated === "boolean";
  } catch {
    return false;
  }
}

/**
 * A token that survives restarts, so the extension is configured once.
 *
 * Generated rather than defaulted: a well-known development token has a way of
 * becoming a deployed one.
 */
async function developmentToken(envName: "INGEST_TOKEN" | "LIBRARY_TOKEN", path: string): Promise<string> {
  const configured = process.env[envName];
  if (configured) return configured;
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch {
    // First run. Fall through and make one.
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, "utf8");
  return token;
}

async function preflight(): Promise<void> {
  const problems: string[] = [];

  if (!(await portIsFree(API_PORT))) {
    const ours = await looksLikeAnansi(API_PORT);
    problems.push(
      ours
        ? `Port ${API_PORT} already has an Anansi API on it. It may be an older build\n` +
          `  answering with the routes it was compiled with, which is a confusing way\n` +
          `  to spend an afternoon. Stop it first:`
        : `Port ${API_PORT} is in use by something that is not the Anansi API. Free it:`,
    );
    problems.push(
      `\n  ${c.dim(
        `powershell -c "Get-NetTCPConnection -LocalPort ${API_PORT} -State Listen | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`,
      )}\n`,
    );
  }

  if (!(await portIsFree(WEB_PORT))) {
    problems.push(`Port ${WEB_PORT} (the web app) is in use.`);
  }

  if (problems.length > 0) {
    console.error(`\n${c.red("Cannot start.")}\n`);
    for (const line of problems) console.error(`  ${line}`);
    console.error("");
    process.exit(1);
  }
}

async function waitForApi(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await looksLikeAnansi(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const children: ReturnType<typeof spawn>[] = [];

function run(command: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  // If either half dies the other is useless, and a half-running stack is the
  // thing that wastes the most time.
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n${c.red(`${command} exited (${code ?? "signal"}). Stopping.`)}`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await preflight();

const token = await developmentToken("INGEST_TOKEN", INGEST_TOKEN_FILE);
const libraryToken = await developmentToken("LIBRARY_TOKEN", LIBRARY_TOKEN_FILE);

run("bun", ["run", join(ROOT, "apps", "web", "scripts", "serve-local.ts")], ROOT, {
  PORT: String(API_PORT),
  ANANSI_DB_PATH: DB_PATH,
  ANANSI_MEDIA_DIR: MEDIA_DIR,
  INGEST_TOKEN: token,
  LIBRARY_TOKEN: libraryToken,
  ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
  ...(process.env.MCP_TOKEN ? { MCP_TOKEN: process.env.MCP_TOKEN } : {}),
});

if (!(await waitForApi(API_PORT))) {
  console.error(`\n${c.red("The API did not come up. Its output is above.")}\n`);
  shutdown(1);
}

run("bunx", ["vite", "dev", "--host", "127.0.0.1", "--port", String(WEB_PORT)], join(ROOT, "apps", "web"), {});

setTimeout(() => {
  console.log(`
${c.bold("  anansi, locally")}

  ${c.green("library")}   http://127.0.0.1:${WEB_PORT}
  ${c.green("api")}       http://127.0.0.1:${WEB_PORT}/api
  ${c.dim("internal")}  http://127.0.0.1:${API_PORT}
  ${c.dim("db")}        ${DB_PATH}

  ${c.bold("extension")}  build once with ANANSI_EXTENSION_ORIGIN set to
             ${c.amber(`http://127.0.0.1:${WEB_PORT}`)} and its private build
             token set to the same value as INGEST_TOKEN.

  ${c.bold("library sign-in")}  ${c.amber(libraryToken)}

  ${c.dim("ctrl-c stops both")}
`);
}, 1_200);
