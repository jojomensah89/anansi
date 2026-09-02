import { parseArgs } from "node:util";
import { createXAdapter } from "./adapters/x/adapter.ts";
import { envCookies, envSession } from "./session/env.ts";
import { reparse, runImport, summarize } from "./core/import.ts";
import type { ImportSummary } from "./core/import.ts";
import { resolveEndpoint } from "./adapters/x/endpoint.ts";
import { recordRun, startIngestServer } from "./ingest/server.ts";
import { reparse as reparseFromDisk } from "./core/import.ts";
import { loadCheckpoint } from "./store/checkpoint.ts";
import { dataPath, ensureDir, readJsonl } from "./store/files.ts";
import type { NormalizedItem } from "./core/item.ts";

const USAGE = `anansi — day 1: the importer

  anansi ingest [--port N]
      THE capture path. Starts a loopback receiver and prints a snippet to
      paste into a logged-in x.com tab. The browser pages your bookmarks
      using the session it already has; you never handle a credential.

  anansi ingest --file <path>
      Read a JSON file the snippet downloaded, for when the bridge popup
      was blocked. Same destination, different courier.


  anansi import x [--since] [--pages N] [--resume] [--dry-run]
      Headless capture for YOUR OWN machine, using cookies in .env. Useful
      for a cron job you run against your own account; never something to
      ask another person to set up. Prefer 'ingest'.

        --since     incremental: stop at the first page holding a known id
        --pages N   stop after N pages (use --pages 1 for a smoke test)
        --resume    continue from the saved cursor
        --dry-run   fetch and store raw pages, leave items.jsonl untouched

  anansi reparse x
      Re-run the parser over raw pages already on disk. No network.

  anansi stats x
      What is currently in the library.

  anansi doctor
      Check the session and the endpoint resolution before a real run.
`;

function report(summary: ImportSummary): void {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  console.log(
    `\n  ${summary.pagesFetched} pages · ${summary.itemsParsed} parsed · ` +
      `${summary.itemsNew} new · ${summary.itemsTotal} in library · ${seconds}s`,
  );
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

async function ingest(port?: number): Promise<void> {
  const startedAt = Date.now();
  const adapter = createXAdapter({});   // parse only; no session, by design

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

  const summary = await reparseFromDisk(createXAdapter({}));
  const alarm = await recordRun("x", { pages: pages.length, items: summary.itemsTotal }, startedAt);
  report({ ...summary, zeroItemAlarm: alarm });
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
      since: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      pages: { type: "string" },
      port: { type: "string" },
      file: { type: "string" },
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
  if (command === "doctor") return doctor();

  if (command !== "import" && command !== "reparse" && command !== "stats") {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  if (target !== "x") {
    // github lands on day 5; the adapter directory is already waiting for it.
    console.error(`Unknown or unimplemented source: ${target ?? "(none)"} — only "x" exists today.`);
    process.exitCode = 1;
    return;
  }

  if (command === "stats") {
    const items = await readJsonl<NormalizedItem>("items-x.jsonl");
    console.log(JSON.stringify(summarize(items), null, 2));
    return;
  }

  const adapter = createXAdapter({ session: envSession });

  if (command === "reparse") {
    console.log("  reparsing raw pages from disk…");
    return report(await reparse(adapter));
  }

  const checkpoint = await loadCheckpoint("x");
  console.log(`  importing x bookmarks${values.since ? " (incremental)" : ""}…`);
  report(
    await runImport(adapter, {
      incremental: values.since,
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
