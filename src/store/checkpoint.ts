import type { Source } from "../core/item.ts";
import { readJson, writeJson } from "./files.ts";

/**
 * Where a run got to, so an interrupted import resumes instead of restarting.
 *
 * Also the ledger the day-13 alarm reads: every run records how many items it
 * produced, and a run that returns zero after a run that didn't is the single
 * failure this project most needs to notice.
 */
export interface RunRecord {
  startedAt: number;
  finishedAt?: number;
  pages: number;
  items: number;
  status: "running" | "ok" | "failed" | "interrupted";
  error?: string;
  endpointSource: string;
}

export interface Checkpoint {
  source: Source;
  /** Null once a run walked off the end of the timeline. */
  cursor: string | null;
  updatedAt: number;
  runs: RunRecord[];
}

function file(source: Source): string {
  return `checkpoint-${source}.json`;
}

export async function loadCheckpoint(source: Source): Promise<Checkpoint> {
  return (
    (await readJson<Checkpoint>(file(source))) ?? {
      source,
      cursor: null,
      updatedAt: 0,
      runs: [],
    }
  );
}

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  cp.updatedAt = Date.now();
  // Keep the tail bounded; the last 50 runs is plenty of history for a trend.
  cp.runs = cp.runs.slice(-50);
  await writeJson(file(cp.source), cp);
}

/** The one alarm from the build spec, as a pure function over the ledger. */
export function zeroItemRegression(cp: Checkpoint): boolean {
  const done = cp.runs.filter((r) => r.status === "ok");
  const last = done.at(-1);
  const prev = done.at(-2);
  return !!last && !!prev && last.items === 0 && prev.items > 0;
}
