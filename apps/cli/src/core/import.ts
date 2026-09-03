import type { CaptureAdapter, CaptureOptions } from "../adapters/types.ts";
import type { NormalizedItem, Source } from "@anansi/sources";
import { itemKey } from "@anansi/sources";
import { loadCheckpoint, saveCheckpoint, zeroItemRegression } from "../store/checkpoint.ts";
import type { RunRecord } from "../store/checkpoint.ts";
import { dataPath, ensureDir, readJsonl, writeJson, writeJsonl } from "../store/files.ts";
import { readdir } from "node:fs/promises";
import { upsertItems } from "@anansi/db";
import { db, ensureMigrated } from "../store/db.ts";

export interface ImportOptions extends CaptureOptions {
  /** Stop at the first page containing an id already on disk. */
  incremental?: boolean;
  /** Fetch and write raw pages, but leave items.jsonl alone. */
  dryRun?: boolean;
}

export interface ImportSummary {
  source: Source;
  pagesFetched: number;
  itemsParsed: number;
  itemsNew: number;
  itemsTotal: number;
  durationMs: number;
  zeroItemAlarm: boolean;
  db?: { inserted: number; updated: number; mediaRows: number };
}

function rawDir(source: Source): string {
  return dataPath("raw", source);
}

function itemsFile(source: Source): string {
  return `items-${source}.jsonl`;
}

/**
 * Raw first, always.
 *
 * Every page is on disk before anything tries to understand it, and the run
 * is only ever one `reparse` away from a corrected parser. It is also the
 * same shape the extension will POST to `/api/ingest` later, so the
 * server-side parsing the spec describes is this function, moved.
 */
export async function runImport(
  adapter: CaptureAdapter,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const source = adapter.source;
  const startedAt = Date.now();
  const importedAt = Math.floor(startedAt / 1000);

  await ensureDir(rawDir(source));
  const existing = await readJsonl<NormalizedItem>(itemsFile(source));
  const byKey = new Map(existing.map((i) => [itemKey(i), i]));
  const knownIds = new Set(existing.map((i) => i.externalId));

  const checkpoint = await loadCheckpoint(source);
  const run: RunRecord = {
    startedAt,
    pages: 0,
    items: 0,
    status: "running",
    endpointSource: "unknown",
  };

  const captureOptions: CaptureOptions = {
    cursor: options.cursor ?? null,
    maxPages: options.maxPages,
    stopAt: options.incremental
      ? (ids) => ids.some((id) => knownIds.has(id))
      : options.stopAt,
  };

  let parsed = 0;
  let added = 0;

  try {
    for await (const page of adapter.pages(captureOptions)) {
      const stamp = String(page.page).padStart(4, "0");
      await Bun.write(
        `${rawDir(source)}/page-${startedAt}-${stamp}.json`,
        JSON.stringify(page.raw),
      );

      const items = adapter.parse(page.raw, { importedAt });
      parsed += items.length;

      for (const item of items) {
        const key = itemKey(item);
        const prior = byKey.get(key);
        if (!prior) added++;
        // Idempotent on (source, external_id) — the same key day 2's upsert
        // uses, so running an import twice never doubles anything.
        byKey.set(key, prior ? { ...item, savedAt: prior.savedAt, savedAtIsExact: prior.savedAtIsExact } : item);
      }

      run.pages = page.page;
      checkpoint.cursor = page.cursor;
      process.stdout.write(
        `  page ${page.page}  +${items.length} parsed  ${byKey.size} held\r`,
      );
    }
    run.status = "ok";
  } catch (err) {
    run.status = "failed";
    run.error = (err as Error).message;
    throw err;
  } finally {
    process.stdout.write("\n");
    run.items = parsed;
    run.finishedAt = Date.now();
    checkpoint.runs.push(run);
    await saveCheckpoint(checkpoint);
  }

  const all = [...byKey.values()].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
  const written = options.dryRun ? undefined : await persist(source, all);

  return {
    source,
    pagesFetched: run.pages,
    itemsParsed: parsed,
    itemsNew: added,
    itemsTotal: all.length,
    durationMs: Date.now() - startedAt,
    zeroItemAlarm: zeroItemRegression(checkpoint),
    db: written,
  };
}

/**
 * Re-run the parser over raw pages already on disk. No network, no session.
 * This is what makes day 1's output "a file you can re-run against".
 */
export async function reparse(adapter: CaptureAdapter): Promise<ImportSummary> {
  const source = adapter.source;
  const started = Date.now();
  const importedAt = Math.floor(started / 1000);

  await ensureDir(rawDir(source));
  const files = (await readdir(rawDir(source))).filter((f) => f.endsWith(".json")).sort();

  const byKey = new Map<string, NormalizedItem>();
  let parsed = 0;

  for (const name of files) {
    const raw = await Bun.file(`${rawDir(source)}/${name}`).json();
    const items = adapter.parse(raw, { importedAt });
    parsed += items.length;
    for (const item of items) byKey.set(itemKey(item), item);
  }

  const all = [...byKey.values()].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
  const written = await persist(source, all);

  return {
    source,
    pagesFetched: files.length,
    itemsParsed: parsed,
    itemsNew: all.length,
    itemsTotal: all.length,
    durationMs: Date.now() - started,
    zeroItemAlarm: false,
    db: written,
  };
}

/**
 * jsonl stays as the durable, diffable record of what the parser produced;
 * the database is what everything queries. Both are written from the same
 * in-memory list so they can never disagree.
 */
async function persist(source: Source, all: NormalizedItem[]) {
  await writeJsonl(itemsFile(source), all);
  await writeJson(`stats-${source}.json`, summarize(all));

  ensureMigrated();
  return upsertItems(db(), all);
}

export function summarize(items: NormalizedItem[]) {
  const authors = new Map<string, number>();
  let withMedia = 0;
  let withLinks = 0;
  let oldest = Infinity;
  let newest = -Infinity;

  for (const item of items) {
    if (item.authorHandle) authors.set(item.authorHandle, (authors.get(item.authorHandle) ?? 0) + 1);
    if (item.media.length) withMedia++;
    if (item.links.length) withLinks++;
    if (item.postedAt) {
      oldest = Math.min(oldest, item.postedAt);
      newest = Math.max(newest, item.postedAt);
    }
  }

  const top = [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return {
    items: items.length,
    authors: authors.size,
    savedExactlyOnce: [...authors.values()].filter((n) => n === 1).length,
    withMedia,
    withLinks,
    oldest: Number.isFinite(oldest) ? new Date(oldest * 1000).toISOString() : null,
    newest: Number.isFinite(newest) ? new Date(newest * 1000).toISOString() : null,
    topAuthors: top.map(([handle, count]) => ({ handle, count })),
  };
}
