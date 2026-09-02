import { parseArgs } from "node:util";
import { createXAdapter } from "./adapters/x/adapter.ts";
import { envCookies, envSession } from "./session/env.ts";
import { reparse, runImport, summarize } from "./core/import.ts";
import type { ImportSummary } from "./core/import.ts";
import { resolveEndpoint } from "./adapters/x/endpoint.ts";
import { loadCheckpoint } from "./store/checkpoint.ts";
import { readJsonl } from "./store/files.ts";
import type { NormalizedItem } from "./core/item.ts";

const USAGE = `anansi — day 1: the importer

  anansi import x [--since] [--pages N] [--resume] [--dry-run]
      Page the bookmarks timeline, write every raw payload to disk, and
      normalize into data/items-x.jsonl. Idempotent on (source, external_id).

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
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
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
