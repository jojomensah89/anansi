import { Database } from "bun:sqlite";
import { toFtsQuery } from "../src/search.ts";

/**
 * How badly does `porter unicode61` handle the 496 non-Latin items?
 *
 * unicode61 splits on non-alphanumeric characters. Japanese and Chinese are
 * written without spaces and every character counts as alphanumeric, so a
 * whole run becomes ONE token — searchable only by exact whole-run match.
 * This measures that against the real library rather than asserting it.
 */
const db = new Database(process.env.ANANSI_DB_PATH ?? "data/anansi.db", { readonly: true });

const row = db
  .query("select author_handle h, body from items where body like ?1 limit 1")
  .get("%UIデザイン%") as { h: string; body: string } | null;

console.log("target: @" + (row?.h ?? "none"));
console.log("  " + (row?.body ?? "").slice(0, 64).replace(/\s+/g, " ") + "\n");
console.log("  query                     FTS   LIKE");

for (const q of ["UIデザイン", "デザイン", "気づいてしまったかもなのだが", "ChatGPT", "AI"]) {
  const hits = db
    .query("select count(*) c from items_fts where items_fts match ?1")
    .get(toFtsQuery(q)) as { c: number };
  const like = db
    .query("select count(*) c from items where body like ?1")
    .get("%" + q + "%") as { c: number };
  const flag = hits.c === 0 && like.c > 0 ? "   <- invisible to search" : "";
  console.log("  " + q.padEnd(26) + String(hits.c).padEnd(6) + String(like.c) + flag);
}
