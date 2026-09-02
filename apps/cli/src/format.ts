import type { SearchHit } from "@anansi/db";

/**
 * Terminal presentation, kept away from the query layer.
 *
 * The escape byte is built rather than written literally so this file stays
 * pasteable and greppable — a raw ESC in source is invisible in a diff and
 * survives copy-paste badly.
 */
const ESC = String.fromCharCode(27);
export const DIM = `${ESC}[2m`;
export const BOLD = `${ESC}[1m`;
export const HIT = `${ESC}[38;5;214m`;
export const OFF = `${ESC}[0m`;

export function when(unix: number | null): string {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "";
}

export function printHits(hits: SearchHit[], showScore = true): void {
  if (hits.length === 0) {
    console.log("\n  nothing matched.\n");
    return;
  }
  console.log("");
  for (const hit of hits) {
    // bm25 is negative and lower is better; shown because when a result looks
    // wrong the score is the first thing that explains why.
    const score = showScore ? `${DIM}${hit.score.toFixed(2)}${OFF}  ` : "";
    const stamp = [when(hit.postedAt), hit.source].filter(Boolean).join(" · ");
    console.log(`  ${score}${BOLD}@${hit.author ?? "unknown"}${OFF} ${DIM}${stamp}${OFF}`);
    console.log(`      ${hit.excerpt.replace(/\s+/g, " ").trim()}`);
    console.log(`      ${DIM}${hit.url}${OFF}\n`);
  }
}

/** Accepts 2026, 2026-08, or 2026-08-18. */
export function parseSince(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const padded =
    input.length === 4 ? `${input}-01-01` : input.length === 7 ? `${input}-01` : input;
  const ms = Date.parse(padded);
  if (!Number.isFinite(ms)) {
    throw new Error(`couldn't read --since ${input}; try 2026, 2026-08 or 2026-08-18.`);
  }
  return Math.floor(ms / 1000);
}
