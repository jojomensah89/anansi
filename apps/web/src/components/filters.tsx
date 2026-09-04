import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Creator, type ItemQuery } from "../lib/api.ts";
import { SourceMark } from "./sourcemark.tsx";

/**
 * The filter bar.
 *
 * A chip is a sentence: field · operator · value. That grammar is doing real
 * work — "Platform is any of 2 selected" survives being read at a glance in a
 * way a bare list of values does not, and without the operator a multi-value
 * chip is ambiguous about whether it widens or narrows the result.
 *
 * Values within one field are ORed and different fields are ANDed, which is
 * the only combination that behaves the way the sentence reads. The
 * alternative — ANDing two platforms — can only ever return nothing, and an
 * empty grid is indistinguishable from a broken library.
 *
 * Applied filters live in the bar rather than behind a menu, because a filter
 * you cannot see is a filter you forget is on.
 *
 * Content type is offered per selected platform. A Reddit save can be a
 * comment and a GitHub star never is, so a flat list would offer options that
 * can only ever return nothing.
 */
export type Filters = Pick<
  ItemQuery,
  "source" | "author" | "media" | "type" | "tag" | "archived" | "removed"
>;

interface Option {
  value: string;
  label: string;
  count?: number;
  /** Rendered before the label: a platform mark, or an author's avatar. */
  icon?: React.ReactNode;
}

type FieldKey = "source" | "type" | "media" | "author" | "tag" | "removed";

interface Field {
  key: FieldKey;
  label: string;
  /** Single-value fields read "is"; multi-value ones read "is any of". */
  multi: boolean;
  icon: React.ReactNode;
  options: Option[];
  searchable?: string;
}

const SOURCES: { value: string; label: string }[] = [
  { value: "x", label: "X" },
  { value: "github", label: "GitHub" },
  { value: "reddit", label: "Reddit" },
  { value: "tiktok", label: "TikTok" },
];

const MEDIA: Option[] = [
  { value: "any", label: "Has media" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "none", label: "No media" },
];

/**
 * Whether the platform still has it.
 *
 * An unsave never deletes anything here, so "removed" is a state to filter on
 * rather than an absence — this is how you go and look at what has gone.
 */
const REMOVED: Option[] = [
  { value: "exclude", label: "Still saved" },
  { value: "only", label: "Removed at source" },
];

const TYPES_BY_SOURCE: Record<string, Option[]> = {
  x: [
    { value: "post", label: "Post" },
    { value: "video", label: "Video" },
    { value: "article", label: "Article" },
    { value: "thread", label: "Thread reply" },
  ],
  reddit: [
    { value: "post", label: "Post" },
    { value: "comment", label: "Comment" },
    { value: "article", label: "Article" },
  ],
  tiktok: [{ value: "video", label: "Video" }],
  github: [{ value: "repo", label: "Repo" }],
};

function allTypes(sources: string[]): Option[] {
  const seen = new Map<string, string>();
  for (const s of sources) for (const t of TYPES_BY_SOURCE[s] ?? []) seen.set(t.value, t.label);
  return [...seen].map(([value, label]) => ({ value, label }));
}

const list = (v: string[] | undefined): string[] => v ?? [];

/* ------------------------------------------------------------- icons --- */

function Icon({ d, fill }: { d: string; fill?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const FIELD_ICONS: Record<FieldKey, React.ReactNode> = {
  source: <Icon d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 8h8" />,
  type: <Icon d="M4 6h16M4 12h16M4 18h10" />,
  media: <Icon d="M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 3-3L20 16" />,
  removed: <Icon d="M6 6l12 12M18 6 6 18" />,
  author: <Icon d="M12 4.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8zM5.5 20c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6" />,
  tag: <Icon d="M4 4h7l9 9-7 7-9-9zM8 8h.01" />,
};

/* --------------------------------------------------------------- bar --- */

export function FilterBar({
  filters,
  onChange,
  bySource,
  matched,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  bySource: Record<string, number>;
  matched: number | null;
}) {
  const [open, setOpen] = useState<FieldKey | null>(null);
  const [adding, setAdding] = useState(false);
  const [tags, setTags] = useState<{ label: string; count: number }[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.tags(controller.signal).then((t) => setTags(t.tags.filter((x) => x.count > 0))).catch(() => {});
    api.creators(300, controller.signal).then((c) => setCreators(c.creators)).catch(() => {});
    return () => controller.abort();
  }, []);

  // A click anywhere else closes the menu, which is what every other menu on
  // the machine does.
  useEffect(() => {
    if (!open && !adding) return;
    const onDown = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) {
        setOpen(null);
        setAdding(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(null);
        setAdding(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, adding]);

  const present = Object.keys(bySource).filter((s) => (bySource[s] ?? 0) > 0);

  const fields: Field[] = useMemo(() => {
    const scope = list(filters.source).length > 0 ? list(filters.source) : present;
    const all: Field[] = [
      {
        key: "source",
        label: "Platform",
        multi: true,
        icon: FIELD_ICONS.source,
        options: SOURCES.filter((s) => (bySource[s.value] ?? 0) > 0).map((s) => ({
          value: s.value,
          label: s.label,
          count: bySource[s.value],
          icon: <SourceMark source={s.value} size={13} />,
        })),
      },
      {
        key: "author",
        label: "Author",
        multi: true,
        icon: FIELD_ICONS.author,
        searchable: "Search authors…",
        options: creators
          .filter((c) => c.authorHandle)
          .map((c) => ({
            value: c.authorHandle as string,
            label: c.authorName ?? (c.authorHandle as string),
            count: c.saves,
            icon: <Avatar creator={c} />,
          })),
      },
      {
        key: "type",
        label: "Content type",
        multi: true,
        icon: FIELD_ICONS.type,
        options: allTypes(scope),
      },
      {
        key: "media",
        label: "Media",
        multi: false,
        icon: FIELD_ICONS.media,
        options: MEDIA,
      },
      {
        key: "removed",
        label: "At source",
        multi: false,
        icon: FIELD_ICONS.removed,
        options: REMOVED,
      },
      {
        key: "tag",
        label: "Tag",
        multi: true,
        icon: FIELD_ICONS.tag,
        searchable: tags.length > 8 ? "Search tags…" : undefined,
        options: tags.map((t) => ({ value: t.label, label: t.label, count: t.count })),
      },
    ];
    return all.filter((f) => f.options.length > 0);
  }, [bySource, creators, tags, filters.source, present]);

  /** Single-value fields hold a string; the rest hold a list. */
  const SINGLE: FieldKey[] = ["media", "removed"];

  const valuesOf = (key: FieldKey): string[] => {
    if (SINGLE.includes(key)) {
      const value = filters[key as "media" | "removed"];
      return value ? [value] : [];
    }
    return list(filters[key] as string[] | undefined);
  };

  const setValues = (key: FieldKey, values: string[]) => {
    if (SINGLE.includes(key)) {
      onChange({ ...filters, [key]: values[0] });
      return;
    }
    onChange({ ...filters, [key]: values.length > 0 ? values : undefined });
  };

  const toggleValue = (field: Field, value: string) => {
    const current = valuesOf(field.key);
    if (!field.multi) {
      setValues(field.key, current[0] === value ? [] : [value]);
      setOpen(null);
      return;
    }
    setValues(
      field.key,
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );
  };

  const applied = fields.filter((f) => valuesOf(f.key).length > 0);
  const unapplied = fields.filter((f) => valuesOf(f.key).length === 0);
  const anyApplied = applied.length > 0 || filters.archived === true;

  const clearAll = () =>
    onChange({
      source: undefined,
      author: undefined,
      media: undefined,
      type: undefined,
      tag: undefined,
      removed: undefined,
      archived: undefined,
    });

  return (
    <div ref={barRef} style={{ position: "relative", flexShrink: 0, borderBottom: "1px solid var(--line)" }}>
      <div
        style={{
          minHeight: 42,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 7,
          padding: "8px 20px",
        }}
      >
        {applied.map((field) => (
          <Chip
            key={field.key}
            field={field}
            values={valuesOf(field.key)}
            open={open === field.key}
            onOpen={() => {
              setAdding(false);
              setOpen(open === field.key ? null : field.key);
            }}
            onClear={() => {
              setValues(field.key, []);
              setOpen(null);
            }}
          />
        ))}

        {filters.archived === true && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, archived: undefined })}
            style={{ ...chipShell, borderColor: "var(--edge-strong)" }}
          >
            <span style={{ ...chipField, color: "var(--muted)" }}>
              <Icon d="M4 7h16v13H4zM4 4h16v3H4zM10 12h4" />
              Archived
            </span>
            <ChipX />
          </button>
        )}

        {unapplied.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setOpen(null);
              setAdding((a) => !a);
            }}
            aria-expanded={adding}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 26,
              padding: "0 9px",
              borderRadius: 5,
              border: "1px dashed var(--edge-strong)",
              background: "transparent",
              color: adding ? "var(--text)" : "var(--muted)",
              fontSize: 11.5,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <Icon d="M12 5v14M5 12h14" />
            Add filter
          </button>
        )}

        {anyApplied && (
          <button
            type="button"
            onClick={clearAll}
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 26,
              padding: "0 8px",
              border: "none",
              background: "transparent",
              color: "var(--faint)",
              fontSize: 10.5,
              cursor: "pointer",
              fontFamily: "var(--mono)",
            }}
          >
            <Icon d="M4 5h16l-6.5 7.5V19l-3 2v-8.5z" />
            Clear all
          </button>
        )}

        {matched !== null && (
          <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faintest)" }}>
            {matched.toLocaleString()} match{matched === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {/* the field picker */}
      {adding && (
        <Menu style={{ left: 20, width: 210 }}>
          {unapplied.map((field) => (
            <MenuRow
              key={field.key}
              onClick={() => {
                setAdding(false);
                setOpen(field.key);
              }}
            >
              <span style={{ color: "var(--faint)", display: "flex" }}>{field.icon}</span>
              <span style={{ fontSize: 12.5 }}>{field.label}</span>
            </MenuRow>
          ))}
        </Menu>
      )}

      {/* the value picker for whichever chip is open */}
      {open && (
        <ValueMenu
          field={fields.find((f) => f.key === open) as Field}
          values={valuesOf(open)}
          onToggle={toggleValue}
          onClear={() => setValues(open, [])}
        />
      )}
    </div>
  );
}

/**
 * One field's chip and menu, on its own.
 *
 * Creators filters by a single dimension, and giving it a second, differently
 * shaped control would mean the app spoke two filter languages. This is the
 * same chip the Library bar builds, with its own open state.
 */
export function FieldFilter({
  label,
  options,
  values,
  onChange,
  searchable,
}: {
  label: string;
  options: Option[];
  values: string[];
  onChange: (values: string[]) => void;
  searchable?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const field: Field = {
    key: "source",
    label,
    multi: true,
    icon: FIELD_ICONS.source,
    options,
    searchable,
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      {values.length > 0 ? (
        <Chip
          field={field}
          values={values}
          open={open}
          onOpen={() => setOpen((o) => !o)}
          onClear={() => {
            onChange([]);
            setOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 26,
            padding: "0 9px",
            borderRadius: 5,
            border: "1px dashed var(--edge-strong)",
            background: "transparent",
            color: open ? "var(--text)" : "var(--muted)",
            fontSize: 11.5,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          {FIELD_ICONS.source}
          {label}
        </button>
      )}

      {open && (
        <ValueMenu
          field={field}
          values={values}
          onToggle={(_f, value) =>
            onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])
          }
          onClear={() => onChange([])}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- chip --- */

const chipShell: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 26,
  borderRadius: 5,
  border: "1px solid #2e373f",
  background: "#1e2329",
  overflow: "hidden",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
  color: "var(--text)",
};

const chipField: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  fontSize: 11.5,
  color: "var(--muted)",
  height: "100%",
};

function ChipX() {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        alignSelf: "stretch",
        borderLeft: "1px solid #2e373f",
        color: "var(--faint)",
      }}
    >
      <Icon d="M6 6l12 12M18 6 6 18" />
    </span>
  );
}

function Chip({
  field,
  values,
  open,
  onOpen,
  onClear,
}: {
  field: Field;
  values: string[];
  open: boolean;
  onOpen: () => void;
  onClear: () => void;
}) {
  const chosen = field.options.filter((o) => values.includes(o.value));
  const icons = chosen.filter((o) => o.icon).slice(0, 3);
  const label =
    chosen.length === 1 ? (chosen[0]?.label ?? values[0]) : `${values.length} selected`;

  return (
    <span style={{ ...chipShell, borderColor: open ? "var(--accent)" : "#2e373f" }}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", height: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "inherit" }}
      >
        <span style={{ ...chipField, color: open ? "var(--accent-text)" : "var(--muted)" }}>
          {field.icon}
          {field.label}
        </span>
        <span
          className="mono"
          style={{
            padding: "0 7px",
            fontSize: 10.5,
            color: "var(--faint)",
            borderLeft: "1px solid #2e373f",
            borderRight: "1px solid #2e373f",
            height: "100%",
            display: "flex",
            alignItems: "center",
          }}
        >
          {field.multi ? "is any of" : "is"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 11.5 }}>
          {icons.length > 0 && (
            <span style={{ display: "flex" }}>
              {icons.map((o, i) => (
                <span
                  key={o.value}
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: "50%",
                    background: "var(--ink)",
                    border: "1px solid #2e373f",
                    marginLeft: i === 0 ? 0 : -5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    color: "var(--text)",
                  }}
                >
                  {o.icon}
                </span>
              ))}
            </span>
          )}
          {label}
        </span>
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${field.label} filter`}
        style={{ display: "flex", padding: 0, background: "none", border: "none", cursor: "pointer", alignSelf: "stretch", color: "inherit" }}
      >
        <ChipX />
      </button>
    </span>
  );
}

/* -------------------------------------------------------------- menu --- */

function Menu({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        marginTop: -3,
        background: "var(--card)",
        border: "1px solid var(--edge-strong)",
        borderRadius: 7,
        boxShadow: "0 14px 34px #00000080, 0 2px 6px #0000004d",
        zIndex: 40,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function MenuRow({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        padding: "6px 7px",
        borderRadius: 5,
        border: "none",
        background: active ? "var(--raised)" : "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ValueMenu({
  field,
  values,
  onToggle,
  onClear,
}: {
  field: Field;
  values: string[];
  onToggle: (field: Field, value: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [field.key]);

  const shown = field.options.filter(
    (o) => query === "" || o.label.toLowerCase().includes(query.toLowerCase()) || o.value.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Menu style={{ left: 20, width: field.searchable ? 268 : 236 }}>
      {field.searchable && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: "1px solid var(--line)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fainter)" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={field.searchable}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--sans)",
              outline: "none",
            }}
          />
        </div>
      )}

      <div className="scroll" style={{ maxHeight: 244, padding: 5, display: "flex", flexDirection: "column", gap: 1 }}>
        {shown.length === 0 && (
          <div className="mono" style={{ padding: "10px 7px", fontSize: 10.5, color: "var(--faint)" }}>
            nothing matches
          </div>
        )}
        {shown.map((option) => {
          const on = values.includes(option.value);
          return (
            <MenuRow key={option.value} active={on} onClick={() => onToggle(field, option.value)}>
              <span
                style={{
                  width: 14,
                  height: 14,
                  flexShrink: 0,
                  borderRadius: field.multi ? 3 : "50%",
                  border: on ? "none" : "1px solid var(--edge-strong)",
                  background: on ? "var(--accent)" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {on && (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 12l5 5L20 6" />
                  </svg>
                )}
              </span>
              {option.icon && (
                <span style={{ display: "flex", alignItems: "center", flexShrink: 0, color: "var(--text-dim)" }}>
                  {option.icon}
                </span>
              )}
              <span
                style={{
                  fontSize: 12.5,
                  color: on ? "var(--text)" : "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {option.label}
              </span>
              {option.count !== undefined && (
                <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>
                  {option.count.toLocaleString()}
                </span>
              )}
            </MenuRow>
          );
        })}
      </div>

      {values.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", padding: "8px 11px", borderTop: "1px solid var(--line)" }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--faintest)" }}>
            {values.length} selected
          </span>
          <button
            type="button"
            onClick={onClear}
            className="mono"
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--faint)", fontSize: 10, cursor: "pointer", fontFamily: "var(--mono)" }}
          >
            Clear
          </button>
        </div>
      )}
    </Menu>
  );
}

function Avatar({ creator }: { creator: Creator }) {
  if (creator.authorAvatar) {
    return (
      <img
        src={creator.authorAvatar}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        style={{ borderRadius: "50%", objectFit: "cover", background: "var(--edge-strong)" }}
      />
    );
  }
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: "var(--edge-strong)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 8.5,
        color: "var(--muted)",
      }}
    >
      {(creator.authorName ?? creator.authorHandle ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
