import type { NormalizedItem, Source } from "@anansi/sources";

/**
 * One raw page exactly as the platform returned it, plus the cursor that
 * follows it. `raw` is written to disk untouched before anything parses it.
 */
export interface CapturePage {
  raw: unknown;
  cursor: string | null;
  /** 1-based, for logging and checkpointing. */
  page: number;
}

export interface CaptureOptions {
  /** Resume from this cursor instead of starting at the top. */
  cursor?: string | null;
  /** Stop after this many pages. Undefined means until the cursor stops moving. */
  maxPages?: number;
  /**
   * Incremental mode: stop as soon as a page contains an id already held.
   * The importer supplies the predicate; the adapter only asks.
   */
  stopAt?: (externalIds: string[]) => boolean;
}

/**
 * The one interface every capture path implements — bookmarklet, CLI,
 * extension, GitHub. `pages` touches the network; `parse` is pure.
 *
 * That split is the whole point: parse runs over payloads already on disk,
 * so fixing a parser never re-fetches, and the five tweet shapes that break
 * naive normalizers can be developed offline against real data.
 */
export interface CaptureAdapter {
  readonly source: Source;
  pages(opts: CaptureOptions): AsyncIterable<CapturePage>;
  parse(raw: unknown, ctx: ParseContext): NormalizedItem[];
}

export interface ParseContext {
  /** Unix seconds stamped on items whose source gives no saved-at. */
  importedAt: number;
}
