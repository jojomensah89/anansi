import type { ItemDetail, SearchHit } from "@anansi/db";

/**
 * The browser's view of the API.
 *
 * Same-origin in production, so the base is empty. In development it points
 * at `serve-local` instead: the Vite dev server's SSR runs under Node, which
 * cannot load bun:sqlite, so it cannot reach the library itself. One env var
 * rather than a proxy, because a proxy would exist only to hide which
 * process is answering.
 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return (await res.json()) as T;
}

export interface ItemRow extends SearchHit {
  saveOrder: number | null;
}

export interface Page {
  items: ItemRow[];
  nextCursor: number | null;
}

export interface Creator {
  authorHandle: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  source: string;
  saves: number;
  lastPosted: number | null;
}

export interface SourceRow {
  source: string;
  items: number;
  captured: number;
  imported: number;
  authors: number;
  lastSavedAt: number | null;
  lastPostedAt: number | null;
  media: number;
  mediaStored: number;
}

export const api = {
  stats: (signal?: AbortSignal) =>
    get<{
      items: number;
      authors: number;
      bySource: Record<string, number>;
      media: { total: number; stored: number };
    }>("/api/stats", signal),

  items: (
    opts: { cursor?: number | null; source?: string; author?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (opts.cursor != null) q.set("cursor", String(opts.cursor));
    if (opts.source) q.set("source", opts.source);
    if (opts.author) q.set("author", opts.author);
    q.set("limit", String(opts.limit ?? 60));
    return get<Page>(`/api/items?${q}`, signal);
  },

  search: (
    query: string,
    opts: { source?: string; author?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams({ q: query, limit: String(opts.limit ?? 20) });
    if (opts.source) q.set("source", opts.source);
    if (opts.author) q.set("author", opts.author);
    return get<{ query: string; results: SearchHit[] }>(`/api/search?${q}`, signal);
  },

  item: (id: string, signal?: AbortSignal) => get<ItemDetail>(`/api/items/${id}`, signal),

  creators: (limit = 200, signal?: AbortSignal) =>
    get<{ creators: Creator[] }>(`/api/creators?limit=${limit}`, signal),

  sources: (signal?: AbortSignal) => get<{ sources: SourceRow[] }>("/api/sources", signal),
};

/** Dates in the UI are always the post's date, never the import stamp. */
export function shortDate(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const now = Date.now();
  const hours = (now - d.getTime()) / 3_600_000;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function compact(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
