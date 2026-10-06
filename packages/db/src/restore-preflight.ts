import type { LibraryExport } from "./organization.ts";
import type { RestoreCounts, RestoreTable } from "./restore.ts";

/** Pure JSON validation so the browser can reject a damaged export before start. */
const TABLES = ["items", "tags", "itemTags", "itemTagOverrides", "itemSourceLinks", "highlights", "media", "collections"] as const satisfies readonly RestoreTable[];
const FIELDS: Record<RestoreTable, { requiredString: string[]; optionalString: string[]; requiredNumber: string[]; optionalNumber: string[] }> = {
  items: {
    requiredString: ["id", "source", "externalId", "url", "kind", "metrics", "raw"],
    optionalString: ["authorHandle", "authorName", "authorAvatar", "title", "body", "articleText", "articleFormat", "searchText", "note", "lang", "captureOrigin"],
    requiredNumber: ["savedAt"],
    optionalNumber: ["contentTruncated", "favorite", "postedAt", "savedAtExact", "saveOrder", "platformSaved", "removedFromSourceAt", "lastSourceEventAt", "archivedAt"],
  },
  tags: { requiredString: ["id", "label", "origin"], optionalString: ["color", "kind"], requiredNumber: [], optionalNumber: [] },
  itemTags: { requiredString: ["itemId", "tagId"], optionalString: ["provenance", "model"], requiredNumber: [], optionalNumber: ["appliedAt"] },
  itemTagOverrides: { requiredString: ["itemId", "tagId", "override"], optionalString: [], requiredNumber: [], optionalNumber: ["createdAt"] },
  itemSourceLinks: { requiredString: ["kind", "externalId", "itemId"], optionalString: [], requiredNumber: ["observedAt"], optionalNumber: ["present"] },
  highlights: { requiredString: ["id", "itemId", "text"], optionalString: [], requiredNumber: ["createdAt"], optionalNumber: [] },
  media: { requiredString: ["id", "itemId", "kind", "originUrl"], optionalString: ["storedKey"], requiredNumber: [], optionalNumber: ["width", "height"] },
  collections: { requiredString: ["id", "name", "filters"], optionalString: [], requiredNumber: ["createdAt", "updatedAt"], optionalNumber: [] },
};
const NON_NULL_OPTIONAL: Partial<Record<RestoreTable, readonly string[]>> = {
  items: ["articleFormat", "searchText", "note", "captureOrigin", "contentTruncated", "favorite", "savedAtExact", "platformSaved"],
  tags: ["color", "kind"],
  itemTags: ["provenance"],
  itemTagOverrides: ["createdAt"],
  itemSourceLinks: ["present"],
};

function unique(rows: Record<string, unknown>[], key: (row: Record<string, unknown>) => string, table: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) throw new Error(`${table} contains duplicate records`);
    seen.add(value);
  }
}

export function validateRestoreBackup(value: unknown): { backup: LibraryExport; counts: RestoreCounts } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This is not an Anansi library export");
  const input = value as Record<string, unknown>;
  if (input.format !== "anansi-library" || input.version !== 1) throw new Error("Unsupported Anansi library export");
  const rowsByTable = {} as Record<RestoreTable, Record<string, unknown>[]>;
  const counts = {} as RestoreCounts;
  for (const table of TABLES) {
    const rows = input[table] ?? ((table === "itemTagOverrides" || table === "itemSourceLinks") ? [] : undefined);
    if (!Array.isArray(rows)) throw new Error(`Export is missing ${table} rows`);
    if (rows.length > 1_000_000) throw new Error(`${table} has too many rows`);
    const fields = FIELDS[table];
    const allowed = new Set([...fields.requiredString, ...fields.optionalString, ...fields.requiredNumber, ...fields.optionalNumber]);
    for (const [index, candidate] of rows.entries()) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${table} row ${index + 1} is invalid`);
      const row = candidate as Record<string, unknown>;
      const requiredStringsValid = fields.requiredString.every((name) => typeof row[name] === "string");
      const requiredNumbersValid = fields.requiredNumber.every((name) => typeof row[name] === "number" && Number.isSafeInteger(row[name]));
      const optionalStringsValid = fields.optionalString.every((name) => row[name] == null || typeof row[name] === "string");
      const optionalNumbersValid = fields.optionalNumber.every((name) => row[name] == null || (typeof row[name] === "number" && (name === "saveOrder" ? Number.isFinite(row[name]) : Number.isSafeInteger(row[name]))));
      const defaultsValid = (NON_NULL_OPTIONAL[table] ?? []).every((name) => row[name] !== null);
      if (!requiredStringsValid || !requiredNumbersValid || !optionalStringsValid || !optionalNumbersValid || !defaultsValid || Object.keys(row).some((name) => !allowed.has(name))) throw new Error(`${table} row ${index + 1} has invalid fields`);
    }
    rowsByTable[table] = rows as Record<string, unknown>[];
    counts[table] = rows.length;
    input[table] = rows;
  }

  const items = rowsByTable.items;
  const tags = rowsByTable.tags;
  unique(items, (row) => String(row.id), "items");
  unique(items, (row) => `${row.source}\0${row.externalId}`, "items");
  unique(tags, (row) => String(row.id), "tags");
  unique(tags, (row) => String(row.label), "tags");
  const itemIds = new Set(items.map((row) => row.id));
  const tagIds = new Set(tags.map((row) => row.id));
  for (const table of ["itemTags", "itemTagOverrides", "itemSourceLinks", "highlights", "media"] as const) {
    for (const row of rowsByTable[table]) {
      if (!itemIds.has(row.itemId)) throw new Error(`${table} refers to a missing item`);
      if ((table === "itemTags" || table === "itemTagOverrides") && !tagIds.has(row.tagId)) throw new Error(`${table} refers to a missing tag`);
    }
  }
  unique(rowsByTable.itemTags, (row) => `${row.itemId}\0${row.tagId}`, "itemTags");
  unique(rowsByTable.itemTagOverrides, (row) => `${row.itemId}\0${row.tagId}`, "itemTagOverrides");
  unique(rowsByTable.itemSourceLinks, (row) => `${row.kind}\0${row.externalId}`, "itemSourceLinks");
  unique(rowsByTable.highlights, (row) => String(row.id), "highlights");
  unique(rowsByTable.highlights, (row) => `${row.itemId}\0${row.text}`, "highlights");
  unique(rowsByTable.media, (row) => String(row.id), "media");
  unique(rowsByTable.media, (row) => `${row.itemId}\0${row.originUrl}`, "media");
  unique(rowsByTable.collections, (row) => String(row.id), "collections");
  for (const row of items) for (const name of ["metrics", "raw"]) {
    try { JSON.parse(row[name] as string); } catch { throw new Error(`items contains invalid ${name} JSON`); }
  }
  for (const row of rowsByTable.collections) {
    try { JSON.parse(row.filters as string); } catch { throw new Error("collections contains invalid filters JSON"); }
  }
  return { backup: input as unknown as LibraryExport, counts };
}
