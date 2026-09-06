import type { CardMedia, ItemDetail, SearchHit } from "@anansi/db";

/**
 * The browser's view of the API.
 *
 * Same-origin in production and development. Locally, Vite proxies `/api`
 * and `/mcp` to the private Bun/SQLite process, so users and the extension
 * have one public Anansi origin in either environment.
 */
const BASE = "";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw await responseError(res, path);
  return (await res.json()) as T;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, { signal, credentials: "include" });
  if (!res.ok) throw await responseError(res, path);
  return (await res.json()) as T;
}

async function send<T>(path: string, method: "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw await responseError(res, path);
  return (await res.json()) as T;
}

async function responseError(res: Response, path: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    detail = body.error ?? body.message ?? "";
  } catch {
    // An empty or non-JSON error response still has useful HTTP status text.
  }
  return new Error(detail || `${res.status} ${res.statusText} for ${path}`);
}

export interface ItemRow extends SearchHit {
  saveOrder: number | null;
  metrics?: Record<string, number>;
  media?: CardMedia[];
  quoted?: {
    handle: string | null;
    name: string | null;
    avatar: string | null;
    text: string;
    url: string | null;
    media: CardMedia[];
  } | null;
}

/** Thumbnails come from our own copy; the key is a path, so it is not escaped. */
export function mediaUrl(key: string): string {
  return `${BASE}/api/media/${key}`;
}

export interface ItemQuery {
  /** Opaque; its shape depends on `order`. Pass back what the page returned. */
  cursor?: string | null;
  /** "is any of": several values on one field widen it, they do not narrow it. */
  source?: string[];
  author?: string[];
  /** Single, because "has media" and "no media" cannot both be true. */
  media?: string;
  type?: string[];
  tag?: string[];
  archived?: boolean;
  favorite?: boolean;
  /** Items the platform no longer has saved. Kept by default. */
  removed?: "include" | "exclude" | "only";
  order?: "saved" | "posted";
  limit?: number;
}

export interface Page {
  items: ItemRow[];
  nextCursor: string | null;
}

export interface SessionState {
  configured: boolean;
  authenticated: boolean;
}

export interface AiSettingsResponse {
  settings: { semanticSearchEnabled: number; autoTaggingEnabled: number; embeddingModel: string; embeddingDimensions: number; tagModel: string; quotaPauseReason: string | null; lastRunAt: number | null };
  progress: { pending: number; failed: number; complete: number };
  available: boolean;
}

export interface Collection {
  id: string;
  name: string;
  filters: ItemQuery & { query?: string };
  createdAt: number;
  updatedAt: number;
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
  name: string;
  host: string;
  note: string;
  support: "supported" | "experimental" | "coming_next";
  mode: "page" | "observe" | "manual";
  toggleable: boolean;
  requiresExtension: boolean;
  enabled: boolean;
  items: number;
  live: number;
  imported: number;
  toolbar: number;
  contextMenu: number;
  chromeBookmarks: number;
  legacyUnknown: number;
  authors: number;
  lastCaptureAt: number | null;
  lastSavedAt: number | null;
  lastPostedAt: number | null;
  media: number;
  mediaStored: number;
  runtime: SourceRuntime | null;
}

export interface QueueCounts {
  queued: number;
  uploading: number;
  retrying: number;
  failed: number;
}

export interface SourceRuntime extends QueueCounts {
  phase: "idle" | "running";
  paused?: boolean;
  lastErrorCode?: string;
}

export interface ExtensionHealth {
  connection: "never_connected" | "connected" | "disconnected";
  extensionVersion: string | null;
  lastSeenAt: number | null;
  activeClients: number;
  queue: QueueCounts;
  sources: Record<string, SourceRuntime>;
}

export interface SourcesResponse {
  extension: ExtensionHealth;
  sources: SourceRow[];
}

export const api = {
	ai: (signal?: AbortSignal) => get<AiSettingsResponse>("/api/ai", signal),
	updateAi: (body: { semanticSearchEnabled?: boolean; autoTaggingEnabled?: boolean }) => send<AiSettingsResponse>("/api/ai", "PATCH", body),
  stats: (signal?: AbortSignal) =>
    get<{
      items: number;
      authors: number;
      archived: number;
      bySource: Record<string, number>;
      media: { total: number; stored: number };
    }>("/api/stats", signal),

  items: (opts: ItemQuery = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.cursor != null) q.set("cursor", String(opts.cursor));
    for (const s of opts.source ?? []) q.append("source", s);
    for (const a of opts.author ?? []) q.append("author", a);
    if (opts.media) q.set("media", opts.media);
    for (const t of opts.type ?? []) q.append("type", t);
    for (const t of opts.tag ?? []) q.append("tag", t);
    if (opts.archived) q.set("archived", "1");
    if (opts.favorite) q.set("favorite", "1");
    if (opts.removed && opts.removed !== "include") q.set("removed", opts.removed);
    if (opts.order === "posted") q.set("order", "posted");
    q.set("limit", String(opts.limit ?? 60));
    return get<Page>(`/api/items?${q}`, signal);
  },

  tags: (signal?: AbortSignal) =>
    get<{ tags: { label: string; color: string; count: number }[] }>("/api/tags", signal),

  archive: (ids: string[], archived = true) => post("/api/items/archive", { ids, archived }),
  tag: (ids: string[], label: string) => post("/api/items/tag", { ids, label }),

  updateItem: (id: string, changes: { note?: string; favorite?: boolean; archived?: boolean }) =>
    send<ItemDetail>(`/api/items/${encodeURIComponent(id)}`, "PATCH", changes),

  addItemTag: (id: string, label: string) =>
    post<{ ok: true }>(`/api/items/${encodeURIComponent(id)}/tags`, { label }),

  removeItemTag: (id: string, label: string) =>
    send<{ ok: true }>(`/api/items/${encodeURIComponent(id)}/tags`, "DELETE", { label }),

  search: (query: string, opts: ItemQuery = {}, signal?: AbortSignal) => {
    const q = itemParams(opts);
    q.set("q", query);
    return get<{ query: string; items: SearchHit[]; nextCursor: string | null }>(`/api/search?${q}`, signal);
  },

  item: (id: string, signal?: AbortSignal) => get<ItemDetail>(`/api/items/${id}`, signal),

  creators: (limit = 200, signal?: AbortSignal) =>
    get<{ creators: Creator[] }>(`/api/creators?limit=${limit}`, signal),

  sources: (signal?: AbortSignal) => get<SourcesResponse>("/api/sources", signal),

  toggleSource: (source: string, enabled: boolean) =>
    post<{ source: string; enabled: boolean }>(`/api/sources/${source}`, { enabled }),

  session: (signal?: AbortSignal) => get<SessionState>("/api/auth/session", signal),
  connect: (token: string) => post<SessionState>("/api/auth/session", { token }),
  disconnect: () => send<SessionState>("/api/auth/session", "DELETE"),

  collections: (signal?: AbortSignal) =>
    get<{ collections: Collection[] }>("/api/collections", signal),
  saveCollection: (name: string, filters: Collection["filters"], id?: string) =>
    post<{ collection: Collection }>("/api/collections", { id, name, filters }),
  deleteCollection: (id: string) =>
    send<{ deleted: true }>(`/api/collections/${encodeURIComponent(id)}`, "DELETE"),

  exportLibrary: async (): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/export`, { credentials: "include" });
    if (!res.ok) throw await responseError(res, "/api/export");
    return res.blob();
  },
};

function itemParams(opts: ItemQuery): URLSearchParams {
  const q = new URLSearchParams();
  if (opts.cursor != null) q.set("cursor", String(opts.cursor));
  for (const s of opts.source ?? []) q.append("source", s);
  for (const a of opts.author ?? []) q.append("author", a);
  if (opts.media) q.set("media", opts.media);
  for (const t of opts.type ?? []) q.append("type", t);
  for (const t of opts.tag ?? []) q.append("tag", t);
  if (opts.archived) q.set("archived", "1");
  if (opts.favorite) q.set("favorite", "1");
  if (opts.removed && opts.removed !== "include") q.set("removed", opts.removed);
  if (opts.order === "posted") q.set("order", "posted");
  q.set("limit", String(opts.limit ?? 60));
  return q;
}

export function sourceLabel(source: string): string {
  return ({
    x: "X bookmarks",
    github: "GitHub stars",
    reddit: "Reddit saves",
    web: "Web pages & bookmarks",
  } as Record<string, string>)[source] ?? source;
}

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

export type { CardMedia } from "@anansi/db";
