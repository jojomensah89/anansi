import { useEffect, useState } from "react";
import { api, type ItemQuery } from "../lib/api.ts";

/**
 * The filter bar.
 *
 * Applied filters live as chips in the existing 42px row rather than behind a
 * menu, because a filter you cannot see is a filter you forget is on — and an
 * unexplained empty grid reads as a broken library.
 *
 * Content type is offered per source. A Reddit save can be a comment and a
 * GitHub star never is, so a flat list would offer options that can only ever
 * return nothing.
 */
export type Filters = Pick<ItemQuery, "source" | "author" | "media" | "type" | "tag" | "archived">;

const MEDIA = [
  { value: "any", label: "has media" },
  { value: "image", label: "image" },
  { value: "video", label: "video" },
  { value: "none", label: "no media" },
];

const TYPES_BY_SOURCE: Record<string, { value: string; label: string }[]> = {
  x: [
    { value: "post", label: "post" },
    { value: "video", label: "video" },
    { value: "article", label: "article" },
    { value: "thread", label: "thread reply" },
  ],
  reddit: [
    { value: "post", label: "post" },
    { value: "comment", label: "comment" },
    { value: "article", label: "article" },
  ],
  tiktok: [{ value: "video", label: "video" }],
  github: [{ value: "repo", label: "repo" }],
};

function allTypes(sources: string[]) {
  const seen = new Map<string, string>();
  for (const s of sources) for (const t of TYPES_BY_SOURCE[s] ?? []) seen.set(t.value, t.label);
  return [...seen].map(([value, label]) => ({ value, label }));
}

export function FilterBar({
  filters,
  onChange,
  bySource,
  loaded,
  matched,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  bySource: Record<string, number>;
  loaded: number;
  matched: number | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [tags, setTags] = useState<{ label: string; count: number }[]>([]);

  useEffect(() => {
    api.tags().then((t) => setTags(t.tags.filter((x) => x.count > 0))).catch(() => {});
  }, []);

  const present = Object.keys(bySource).filter((s) => (bySource[s] ?? 0) > 0);
  const types = allTypes(filters.source ? [filters.source] : present.length ? present : ["x"]);
  const set = (patch: Filters) => {
    onChange({ ...filters, ...patch });
    setOpen(null);
  };

  const chips: { key: string; value: string; clear: Filters }[] = [];
  if (filters.source) chips.push({ key: "source", value: filters.source, clear: { source: undefined } });
  if (filters.type) chips.push({ key: "type", value: filters.type, clear: { type: undefined } });
  if (filters.media) chips.push({ key: "media", value: filters.media, clear: { media: undefined } });
  if (filters.author) chips.push({ key: "author", value: `@${filters.author}`, clear: { author: undefined } });
  if (filters.tag) chips.push({ key: "tag", value: filters.tag, clear: { tag: undefined } });
  if (filters.archived) chips.push({ key: "", value: "archived", clear: { archived: undefined } });

  return (
    <div style={{ position: "relative", flexShrink: 0, borderBottom: "1px solid var(--line)" }}>
      <div style={{ height: 42, display: "flex", alignItems: "center", gap: 7, padding: "0 20px" }}>
        <Menu label="Source" active={!!filters.source} onClick={() => setOpen(open === "source" ? null : "source")} />
        <Menu label="Type" active={!!filters.type} onClick={() => setOpen(open === "type" ? null : "type")} />
        <Menu label="Media" active={!!filters.media} onClick={() => setOpen(open === "media" ? null : "media")} />
        {tags.length > 0 && (
          <Menu label="Tag" active={!!filters.tag} onClick={() => setOpen(open === "tag" ? null : "tag")} />
        )}
        <Menu
          label="Archived"
          active={!!filters.archived}
          onClick={() => set({ archived: filters.archived ? undefined : true })}
        />

        <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 3px" }} />

        {chips.map((c) => (
          <button
            key={c.key + c.value}
            type="button"
            onClick={() => set(c.clear)}
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 4,
              background: "#1e2329",
              border: "1px solid #2e373f",
              color: "var(--text)",
              cursor: "pointer",
              fontFamily: "var(--mono)",
            }}
          >
            {c.key && <span style={{ color: "var(--faint)" }}>{c.key}</span>}
            {c.value}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ))}

        {chips.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="mono"
            style={{ fontSize: 10.5, color: "var(--fainter)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--mono)" }}
          >
            clear all
          </button>
        )}

        <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: chips.length ? "var(--accent)" : "var(--fainter)" }}>
          {loaded} loaded{matched !== null && chips.length ? ` · ${matched} match` : ""}
        </span>
      </div>

      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
          <div
            style={{
              position: "absolute",
              top: 42,
              left: 20,
              zIndex: 21,
              minWidth: 220,
              background: "#10151a",
              border: "1px solid var(--edge-strong)",
              borderRadius: 7,
              padding: 6,
              boxShadow: "0 18px 44px -14px #000000cc",
            }}
          >
            {open === "source" &&
              present.map((s) => (
                <Option key={s} label={s} count={bySource[s]} on={filters.source === s} onClick={() => set({ source: filters.source === s ? undefined : s, type: undefined })} />
              ))}
            {open === "type" &&
              types.map((t) => (
                <Option key={t.value} label={t.label} on={filters.type === t.value} onClick={() => set({ type: filters.type === t.value ? undefined : t.value })} />
              ))}
            {open === "media" &&
              MEDIA.map((m) => (
                <Option key={m.value} label={m.label} on={filters.media === m.value} onClick={() => set({ media: filters.media === m.value ? undefined : m.value })} />
              ))}
            {open === "tag" &&
              tags.map((t) => (
                <Option key={t.label} label={t.label} count={t.count} on={filters.tag === t.label} onClick={() => set({ tag: filters.tag === t.label ? undefined : t.label })} />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function Menu({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        fontSize: 11,
        padding: "4px 9px",
        borderRadius: 4,
        cursor: "pointer",
        fontFamily: "var(--mono)",
        background: active ? "#1e2329" : "transparent",
        color: active ? "var(--text)" : "var(--muted)",
        border: `1px solid ${active ? "#2e373f" : "var(--line)"}`,
      }}
    >
      {label}
    </button>
  );
}

function Option({ label, count, on, onClick }: { label: string; count?: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        padding: "7px 9px",
        borderRadius: 5,
        border: "none",
        cursor: "pointer",
        background: on ? "var(--raised)" : "transparent",
        color: on ? "var(--text)" : "var(--muted)",
        font: "inherit",
        fontSize: 12.5,
        textAlign: "left",
      }}
    >
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 3,
          border: `1px solid ${on ? "var(--accent)" : "var(--edge-strong)"}`,
          background: on ? "var(--accent)" : "transparent",
          flexShrink: 0,
        }}
      />
      {label}
      {count !== undefined && (
        <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--fainter)" }}>
          {count}
        </span>
      )}
    </button>
  );
}
