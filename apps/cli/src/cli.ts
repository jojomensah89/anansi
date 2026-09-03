import { parseArgs } from "node:util";
import { createXAdapter } from "./adapters/x/adapter.ts";
import { createGithubAdapter } from "./adapters/github/adapter.ts";
import type { CaptureAdapter } from "./adapters/types.ts";
import { envCookies, envSession } from "./session/env.ts";
import { reparse, runImport, summarize } from "./core/import.ts";
import type { ImportSummary } from "./core/import.ts";
import { resolveEndpoint } from "./adapters/x/endpoint.ts";
import { recordRun, startIngestServer } from "./ingest/server.ts";
import { reparse as reparseFromDisk } from "./core/import.ts";
import { loadCheckpoint } from "./store/checkpoint.ts";
import { dataPath, ensureDir, readJsonl } from "./store/files.ts";
import type { NormalizedItem } from "./core/item.ts";
import { countItems, creators, findByAuthor, recentSaves, searchItems } from "@anansi/db";
import { HIT, OFF, parseSince, printHits } from "./format.ts";
import { createAnansiServer } from "@anansi/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { db, dbPath, ensureMigrated } from "./store/db.ts";
import { localSink, r2Config, r2Sink } from "./media/sink.ts";
import { syncMedia } from "./media/sync.ts";
import type { MediaSize } from "./media/sync.ts";

const USAGE = `anansi — day 1: the importer

  anansi ingest [--port N]
      THE capture path. Starts a loopback receiver and prints a snippet to
      paste into a logged-in x.com tab. The browser pages your bookmarks
      using the session it already has; you never handle a credential.

  anansi ingest --file <path>
      Read a JSON file the snippet downloaded, for when the bridge popup
      was blocked. Same destination, different courier.


  anansi import github [--incremental] [--pages N]
      Your starred repos. Documented API, a scoped token, and a real
      starred_at — the only exact saved-at in the library.

  anansi import x [--incremental] [--pages N] [--resume] [--dry-run]
      Headless capture for YOUR OWN machine, using cookies in .env. Useful
      for a cron job you run against your own account; never something to
      ask another person to set up. Prefer 'ingest'.

        --incremental  stop at the first page holding a known id
        --pages N   stop after N pages (use --pages 1 for a smoke test)
        --resume    continue from the saved cursor
        --dry-run   fetch and store raw pages, leave items.jsonl untouched

  anansi reparse x
      Re-run the parser over raw pages already on disk. No network.

  anansi stats x
      What is currently in the library.

  anansi search "<query>" [--author h] [--source x] [--since 2026-08] [--limit N]
      Keyword search. bm25 ranked, snippet highlighted.
      --author alone lists everything from that handle.

  anansi recent [--limit N]
      Newest saves first.

  anansi serve --mcp
      Serve the four MCP tools over stdio, for your own agent. Speaks
      JSON-RPC on stdout; point Claude Code at it, do not run it by hand.

  anansi media sync [--limit N] [--size small|medium] [--r2]
      Fetch thumbnails for every media row that has none. Local by default;
      --r2 uploads instead. Video is stored as its poster, never the MP4.

  anansi db migrate
      Create or update the local SQLite library at data/anansi.db.

  anansi db creators
      Top authors, straight out of the database as a group-by.

  anansi doctor
      Check the session and the endpoint resolution before a real run.
`;

function report(summary: ImportSummary): void {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  console.log(
    `\n  ${summary.pagesFetched} pages · ${summary.itemsParsed} parsed · ` +
      `${summary.itemsNew} new · ${summary.itemsTotal} in library · ${seconds}s`,
  );
  if (summary.db) {
    console.log(
      `  db: ${summary.db.inserted} inserted · ${summary.db.updated} updated · ` +
        `${summary.db.mediaRows} media rows`,
    );
  }
  if (summary.itemsParsed === 0) {
    console.error(
      "\n  ZERO ITEMS. This is the failure the build spec names as the one that\n" +
        "  silently ends projects like this. Check `anansi doctor` before assuming\n" +
        "  your bookmarks are gone.",
    );
    process.exitCode = 1;
  }
  if (summary.zeroItemAlarm) {
    console.error("\n  ALARM: this run returned zero items and the previous one did not.");
    process.exitCode = 1;
  }
}

/**
 * The only place that knows which sources exist.
 *
 * `capture: false` builds a parse-only adapter — reparse and the ingest
 * server both need to normalize payloads already on disk, and neither should
 * be able to demand a credential to do it.
 */
function adapterFor(source: string, capture = false): CaptureAdapter | undefined {
  if (source === "x") return createXAdapter(capture ? { session: envSession } : {});
  if (source === "github") return createGithubAdapter();
  return undefined;
}

async function ingest(port?: number): Promise<void> {
  const startedAt = Date.now();
  const adapter = adapterFor("x")!;   // parse only; no session, by design

  const server = await startIngestServer({
    source: "x",
    port,
    onDone: async (stats) => {
      console.log(`\n  page reported ${stats.pages} pages, ${stats.items} items. Parsing…`);
      const summary = await reparseFromDisk(adapter);
      const alarm = await recordRun("x", { pages: stats.pages, items: summary.itemsTotal }, startedAt);
      report({ ...summary, zeroItemAlarm: alarm });
    },
  });

  const template = await Bun.file(new URL("../snippets/import.js", import.meta.url)).text();
  const snippet = template
    .replaceAll("__ANANSI_ENDPOINT__", server.url)
    .replaceAll("__ANANSI_TOKEN__", server.token);

  console.log(`  listening on ${server.url}\n`);
  console.log("  1. open https://x.com/i/bookmarks in a logged-in tab");
  console.log("  2. open DevTools > Console");
  console.log("  3. paste everything between the lines below, press enter\n");
  console.log("  " + "-".repeat(72));
  console.log(snippet);
  console.log("  " + "-".repeat(72) + "\n");
  console.log("  waiting… ctrl-c to stop.\n");

  await server.finished;
  server.stop();
}

/**
 * The popup-blocked path: one JSON file the page downloaded, holding every
 * raw page. Same destination as the bridge, different courier.
 */
async function ingestFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`  no such file: ${path}`);
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const doc = (await file.json()) as { source?: string; pages?: { page: number; raw: unknown }[] };
  const pages = doc.pages ?? [];
  if (pages.length === 0) {
    console.error("  that file holds no pages.");
    process.exitCode = 1;
    return;
  }

  const dir = dataPath("raw", "x");
  await ensureDir(dir);
  for (const { page, raw } of pages) {
    await Bun.write(
      `${dir}/page-${startedAt}-${String(page).padStart(4, "0")}.json`,
      JSON.stringify(raw),
    );
  }
  console.log(`  wrote ${pages.length} raw pages. Parsing…`);

  const summary = await reparseFromDisk(adapterFor("x")!);
  const alarm = await recordRun("x", { pages: pages.length, items: summary.itemsTotal }, startedAt);
  report({ ...summary, zeroItemAlarm: alarm });
}

async function dbCommand(sub: string | undefined): Promise<void> {
  if (sub === "migrate" || sub === undefined) {
    ensureMigrated();
    console.log(`  migrated ${dbPath()}`);
    console.log(`  ${await countItems(db())} items`);
    return;
  }
  if (sub === "creators") {
    for (const row of await creators(db(), 15)) {
      console.log(`  ${String(row.saves).padStart(4)}  @${row.authorHandle}`);
    }
    return;
  }
  console.error(`Unknown db subcommand: ${sub}`);
  process.exitCode = 1;
}

async function search(
  query: string | undefined,
  opts: { author?: string; source?: string; since?: string; limit?: string },
): Promise<void> {
  // --author with no query is the whole of that author, newest first. It is
  // the same question find_by_author answers for an agent.
  if (opts.author && !query) {
    return printHits(await findByAuthor(db(), opts.author, Number(opts.limit ?? 20)), false);
  }
  if (!query) {
    console.error('  what are you looking for?  anansi search "ai sdk artifacts"');
    process.exitCode = 1;
    return;
  }

  printHits(
    await searchItems(db(), {
      query,
      author: opts.author,
      source: opts.source,
      since: parseSince(opts.since),
      limit: Number(opts.limit ?? 10),
      mark: [HIT, OFF],
    }),
  );
}

/**
 * stdio MCP over the local file. The daily driver, and it needs no deploy.
 *
 * Nothing may be written to stdout here: stdout IS the JSON-RPC channel, and
 * a stray console.log corrupts the stream in a way that presents as the
 * client silently failing to connect. Diagnostics go to stderr.
 */
async function serveMcp(): Promise<void> {
  ensureMigrated();
  const server = createAnansiServer(db());
  console.error(`anansi mcp: ${await countItems(db())} items from ${dbPath()}`);
  await server.connect(new StdioServerTransport());
}

async function mediaCommand(sub: string | undefined, values: Record<string, unknown>): Promise<void> {
  if (sub !== "sync" && sub !== undefined) {
    console.error(`Unknown media subcommand: ${sub}`);
    process.exitCode = 1;
    return;
  }
  ensureMigrated();

  const wantR2 = values.r2 === true;
  const config = r2Config();
  if (wantR2 && !config) {
    console.error(
      "  --r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in .env.",
    );
    process.exitCode = 1;
    return;
  }
  const sink = wantR2 && config ? r2Sink(config) : localSink();

  console.log(`  storing to ${sink.name}`);
  const result = await syncMedia(db(), {
    sink,
    size: (values.size as MediaSize) ?? "small",
    limit: values.limit ? Number(values.limit) : undefined,
    // Carriage return only overwrites on a terminal; piped or redirected
    // line per item, which is how you get a 1,200-line log for a progress bar.
    onProgress: (done, total) => {
      if (process.stdout.isTTY)
        process.stdout.write(`  ${done}/${total}\r`);
      else if (done % 200 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });
  if (process.stdout.isTTY) process.stdout.write("\n");

  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  const secs = (result.durationMs / 1000).toFixed(1);
  console.log(
    `  ${result.stored} stored · ${result.skipped} already present · ` +
      `${result.failed.length} failed · ${mb} MB · ${secs}s`,
  );
  console.log(`  ${result.storedOverall}/${result.total} media rows now stored`);

  if (result.failed.length) {
    console.log("\n  failures (first 5):");
    for (const f of result.failed.slice(0, 5)) {
      console.log(`    ${f.reason}  ${f.url}`);
    }
  }
}

async function doctor(): Promise<void> {
  console.log("  session provider  env (.env cookies)");
  const hasCookies = !!process.env.X_AUTH_TOKEN?.trim() && !!process.env.X_CSRF_TOKEN?.trim();
  console.log(`  cookies           ${hasCookies ? "present" : "MISSING — see .env.example"}`);

  const endpoint = await resolveEndpoint({ refresh: true, cookies: envCookies() });
  console.log(`  queryId           ${endpoint.bookmarksQueryId}  (${endpoint.source})`);
  console.log(`  bearer            ${endpoint.bearer.slice(0, 18)}…  (${endpoint.source})`);

  const cp = await loadCheckpoint("x");
  const last = cp.runs.at(-1);
  console.log(
    `  last run          ${last ? `${new Date(last.startedAt).toISOString()} · ${last.status} · ${last.items} items` : "none"}`,
  );
  console.log(`  cursor            ${cp.cursor ? cp.cursor.slice(0, 24) + "…" : "none"}`);

  if (!hasCookies) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      resume: { type: "boolean", default: false },
      incremental: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      pages: { type: "string" },
      limit: { type: "string" },
      port: { type: "string" },
      file: { type: "string" },
      author: { type: "string" },
      source: { type: "string" },
      since: { type: "string" },
      mcp: { type: "boolean", default: false },
      r2: { type: "boolean", default: false },
      size: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  if (command === "ingest") {
    return values.file
      ? ingestFile(values.file)
      : ingest(values.port ? Number(values.port) : undefined);
  }
  if (command === "search") {
    return search(positionals.slice(1).join(" ") || undefined, {
      author: values.author,
      source: values.source,
      since: values.since,
      limit: values.limit,
    });
  }
  if (command === "recent") {
    return printHits(await recentSaves(db(), values.source, Number(values.limit ?? 20)), false);
  }
  if (command === "serve") return serveMcp();
  if (command === "media") return mediaCommand(target, values);
  if (command === "db") return dbCommand(target);
  if (command === "doctor") return doctor();

  if (command !== "import" && command !== "reparse" && command !== "stats") {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const source = target ?? "x";
  if (!adapterFor(source)) {
    console.error(`Unknown source: ${source}. Try "x" or "github".`);
    process.exitCode = 1;
    return;
  }

  if (command === "stats") {
    const items = await readJsonl<NormalizedItem>(`items-${source}.jsonl`);
    console.log(JSON.stringify(summarize(items), null, 2));
    return;
  }

  const adapter = adapterFor(source, true)!;

  if (command === "reparse") {
    console.log("  reparsing raw pages from disk…");
    return report(await reparse(adapter));
  }

  const checkpoint = await loadCheckpoint(source as "x" | "github");
  console.log(`  importing ${source}${values.incremental ? " (incremental)" : ""}…`);
  report(
    await runImport(adapter, {
      incremental: values.incremental,
      cursor: values.resume ? checkpoint.cursor : null,
      maxPages: values.pages ? Number(values.pages) : undefined,
      dryRun: values["dry-run"],
    }),
  );
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}`);
  process.exitCode = 1;
});
