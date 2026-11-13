import { Button } from "@anansi/ui/components/button";
import { Checkbox } from "@anansi/ui/components/checkbox";
import { Input } from "@anansi/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@anansi/ui/components/popover";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, LIBRARY_SOURCES, sourceLabel, type Creator, type ItemQuery } from "../lib/api.ts";
import { Avatar } from "./avatar.tsx";
import { SourceMark } from "./sourcemark.tsx";
import { TagDot } from "./tag-chip.tsx";
import { formatCount } from "../lib/format.ts";

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
 * The bar comes in two halves that live in different places: the Add-filter
 * button belongs in the toolbar beside the views and the search, and the
 * applied chips belong on their own row where they can wrap. They share state
 * through `useFilterBar`, because only one popover may be open at a time.
 *
 * Content type is offered per selected platform. A Reddit save can be a
 * comment and a GitHub star never is, so a flat list would offer options that
 * can only ever return nothing.
 */
export type Filters = Pick<
  ItemQuery,
  "source" | "author" | "media" | "type" | "tag" | "archived" | "favorite" | "removed" | "nsfw"
>;

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  /** Rendered before the label: a platform mark, or an author's avatar. */
  icon?: React.ReactNode;
}

export type FieldKey = "source" | "type" | "media" | "author" | "tag" | "removed";

export interface Field {
  key: FieldKey;
  label: string;
  /** Single-value fields read "is"; multi-value ones read "is any of". */
  multi: boolean;
  icon: React.ReactNode;
  options: FilterOption[];
  searchable?: string;
}

/**
 * Every platform the library can hold.
 *
 * The bar offers only the ones you actually have — a filter that can only
 * ever return nothing is not worth a row in a menu — so this is the full set
 * and the count decides what appears.
 */
const SOURCES: { value: string; label: string }[] = LIBRARY_SOURCES.map((value) => ({
  value,
  label: sourceLabel(value),
}));

const MEDIA: FilterOption[] = [
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
const REMOVED: FilterOption[] = [
  { value: "exclude", label: "Still saved" },
  { value: "only", label: "Removed at source" },
];

const TYPES_BY_SOURCE: Record<string, FilterOption[]> = {
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
  github: [{ value: "repo", label: "Repo" }],
  web: [{ value: "article", label: "Page" }],
};

function allTypes(sources: string[]): FilterOption[] {
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

export interface FilterBar {
  fields: Field[];
  applied: Field[];
  unapplied: Field[];
  valuesOf: (key: FieldKey) => string[];
  setValues: (key: FieldKey, values: string[]) => void;
  toggleValue: (field: Field, value: string) => void;
  clearAll: () => void;
  clearArchived: () => void;
  anyApplied: boolean;
  /** Which applied chip has its value list open. */
  openChip: FieldKey | null;
  setOpenChip: (key: FieldKey | null) => void;
  /** The Add-filter popover: closed, listing fields, or inside one. */
  picking: "fields" | FieldKey | null;
  setPicking: (next: "fields" | FieldKey | null) => void;
  archived: boolean;
}

/** Single-value fields hold a string; every other field holds a list. */
const SINGLE: FieldKey[] = ["media", "removed"];

/**
 * One bar's worth of state, shared by two components in two places.
 *
 * Only one popover may be open at a time, and clearing a field has to close
 * whatever was showing it, so that truth cannot live in either half.
 */
export function useFilterBar({
  filters,
  onChange,
  bySource,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  bySource: Record<string, number>;
}): FilterBar {
  const [openChip, setOpenChip] = useState<FieldKey | null>(null);
  const [picking, setPicking] = useState<"fields" | FieldKey | null>(null);
  const [tags, setTags] = useState<{ label: string; color: string; count: number; kind?: "topic" | "custom" }[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api.tags(controller.signal).then((t) => setTags(t.tags.filter((x) => x.count > 0))).catch(() => {});
    api.creators(300, controller.signal).then((c) => setCreators(c.creators)).catch(() => {});
    return () => controller.abort();
  }, []);

  const present = Object.keys(bySource).filter((s) => (bySource[s] ?? 0) > 0);

  const fields: Field[] = useMemo(() => {
    const scope = list(filters.source).length > 0 ? list(filters.source) : present;
    const all: Field[] = [
      {
        key: "source",
        label: "Source",
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
            icon: <Avatar src={c.authorAvatar} seed={c.authorHandle ?? c.authorName} name={c.authorName} size={16} />,
          })),
      },
      {
        key: "type",
        label: "Content type",
        multi: true,
        icon: FIELD_ICONS.type,
        options: allTypes(scope),
      },
      { key: "media", label: "Media", multi: false, icon: FIELD_ICONS.media, options: MEDIA },
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
        options: tags.map((t) => ({
			value: t.label,
			label: t.label,
			count: t.count,
			// AI topics carry their dot here too; the owner's own tags stay plain.
			icon: t.kind === "topic" ? <TagDot label={t.label} /> : undefined,
		})),
      },
    ];
    return all.filter((f) => f.options.length > 0);
  }, [bySource, creators, tags, filters.source, present]);

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
      setOpenChip(null);
      setPicking(null);
      return;
    }
    setValues(
      field.key,
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );
  };

  const applied = fields.filter((f) => valuesOf(f.key).length > 0);

  return {
    fields,
    applied,
    unapplied: fields.filter((f) => valuesOf(f.key).length === 0),
    valuesOf,
    setValues,
    toggleValue,
    clearAll: () =>
      onChange({
        source: undefined,
        author: undefined,
        media: undefined,
        type: undefined,
        tag: undefined,
        removed: undefined,
        archived: undefined,
        favorite: undefined,
      }),
    clearArchived: () => onChange({ ...filters, archived: undefined }),
    anyApplied: applied.length > 0 || filters.archived === true || filters.favorite === true,
    openChip,
    setOpenChip,
    picking,
    setPicking,
    archived: filters.archived === true,
  };
}

/**
 * The Add-filter button, for the filter row.
 *
 * Its popover is two levels deep in one place — fields, then that field's
 * values — rather than opening a second popover somewhere else on screen.
 * Choosing a field and then hunting for where its values appeared is the
 * failure this shape avoids.
 */
export function FilterTrigger({ bar, align = "right" }: { bar: FilterBar; align?: "left" | "right" }) {
  const field = bar.fields.find((f) => f.key === bar.picking);

  return (
    <Popover
      open={bar.picking !== null}
      onOpenChange={(open) => {
        bar.setOpenChip(null);
        bar.setPicking(open ? "fields" : null);
      }}
    >
      <PopoverTrigger render={<Button variant="outline" className="filter-trigger" />}>
        <Icon d="M4 5h16l-6.5 7.5V19l-3 2v-8.5z" />
        Filter
      </PopoverTrigger>
      <FilterMenuContent align={align === "left" ? "start" : "end"} searchable={Boolean(field?.searchable)}>
        {field ? (
          <ValueList
            field={field}
            values={bar.valuesOf(field.key)}
            onToggle={bar.toggleValue}
            onClear={() => bar.setValues(field.key, [])}
            onBack={() => bar.setPicking("fields")}
          />
        ) : bar.unapplied.length === 0 ? (
          <p className="filter-menu-empty">Every filter is already on</p>
        ) : (
          <div className="filter-menu-list" role="group" aria-label="Filter by">
            {bar.unapplied.map((f) => (
              <Button key={f.key} variant="ghost" className="filter-menu-field" onClick={() => bar.setPicking(f.key)}>
                <span className="filter-menu-icon">{f.icon}</span>
                <span>{f.label}</span>
                <span className="filter-menu-chevron">
                  <Icon d="M9 6l6 6-6 6" />
                </span>
              </Button>
            ))}
          </div>
        )}
      </FilterMenuContent>
    </Popover>
  );
}

/**
 * The applied filters, on their own row.
 *
 * Each chip owns its popover, so the value list opens under the chip that
 * names it rather than at a fixed spot on the row.
 */
export function FilterChips({ bar, matched }: { bar: FilterBar; matched: number | null }) {
  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          minHeight: 40,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          padding: "8px 20px",
        }}
      >
        {bar.applied.map((field) => (
          <Popover
            key={field.key}
            open={bar.openChip === field.key}
            onOpenChange={(open) => {
              bar.setPicking(null);
              bar.setOpenChip(open ? field.key : null);
            }}
          >
            <Chip
              field={field}
              values={bar.valuesOf(field.key)}
              open={bar.openChip === field.key}
              onClear={() => {
                bar.setValues(field.key, []);
                bar.setOpenChip(null);
              }}
            />
            <FilterMenuContent searchable={Boolean(field.searchable)}>
              <ValueList
                field={field}
                values={bar.valuesOf(field.key)}
                onToggle={bar.toggleValue}
                onClear={() => bar.setValues(field.key, [])}
              />
            </FilterMenuContent>
          </Popover>
        ))}

        {bar.archived && (
          <span style={{ ...chipShell, borderColor: "var(--edge-strong)" }}>
            <span style={{ ...chipField, color: "var(--muted)" }}>
              <Icon d="M4 7h16v13H4zM4 4h16v3H4zM10 12h4" />
              Archived
            </span>
            <Button variant="ghost" onClick={bar.clearArchived} aria-label="Clear Archived filter" className="filter-chip-clear">
              <ChipX />
            </Button>
          </span>
        )}

        {bar.anyApplied && (
          <Button variant="ghost" size="sm" onClick={bar.clearAll} className="filter-clear-all">
            <Icon d="M6 6l12 12M18 6 6 18" />
            Clear all
          </Button>
        )}

        {bar.anyApplied && matched !== null && (
          <span
            className="filter-match-count"
            style={{ marginLeft: "auto", fontSize: "var(--text-meta)", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
          >
            {formatCount(matched)} match{matched === 1 ? "" : "es"}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One field's chip and menu, on its own.
 *
 * Creators filters by a single dimension, and giving it a second, differently
 * shaped control would mean the app spoke two filter languages. This is the
 * same chip and the same menu the Library bar builds, with its own open state.
 */
export function FieldFilter({
  label,
  options,
  values,
  onChange,
  searchable,
}: {
  label: string;
  options: FilterOption[];
  values: string[];
  onChange: (values: string[]) => void;
  searchable?: string;
}) {
  const [open, setOpen] = useState(false);
  // The trigger swaps from a button to a chip on the first pick. Anchoring the
  // menu to this wrapper keeps it in place instead of jumping to the corner.
  const anchorRef = useRef<HTMLSpanElement>(null);

  const field: Field = {
    key: "source",
    label,
    multi: true,
    icon: FIELD_ICONS.source,
    options,
    searchable,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
      {values.length > 0 ? (
        <Chip
          field={field}
          values={values}
          open={open}
          onClear={() => {
            onChange([]);
            setOpen(false);
          }}
        />
      ) : (
        <PopoverTrigger render={<Button variant="outline" className="filter-trigger" />}>
          {FIELD_ICONS.source}
          {label}
        </PopoverTrigger>
      )}
      </span>
      <FilterMenuContent searchable={Boolean(searchable)} anchor={anchorRef}>
        <ValueList
          field={field}
          values={values}
          onToggle={(_f, value) =>
            onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])
          }
          onClear={() => onChange([])}
        />
      </FilterMenuContent>
    </Popover>
  );
}

/* -------------------------------------------------------------- chip --- */

const chipShell: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 32,
  borderRadius: 6,
  border: "1px solid var(--edge)",
  background: "var(--raised)",
  overflow: "hidden",
  padding: 0,
  color: "var(--text)",
};

const chipField: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  fontSize: "var(--text-body)",
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
        width: 28,
        alignSelf: "stretch",
        borderLeft: "1px solid var(--edge)",
        color: "var(--muted)",
      }}
    >
      <Icon d="M6 6l12 12M18 6 6 18" />
    </span>
  );
}

/** Must render inside a `Popover`: its main half is that popover's trigger. */
function Chip({
  field,
  values,
  open,
  onClear,
}: {
  field: Field;
  values: string[];
  open: boolean;
  onClear: () => void;
}) {
  const valuesSet = new Set(values);
  const chosen = field.options.filter((o) => valuesSet.has(o.value));
  const icons = chosen.filter((o) => o.icon).slice(0, 3);
  const label = chosen.length === 1 ? (chosen[0]?.label ?? values[0]) : `${values.length} selected`;

  return (
    <span style={{ ...chipShell, borderColor: open ? "var(--accent)" : "var(--edge)" }}>
      <PopoverTrigger render={<Button variant="ghost" className="filter-chip-open" />}>
        <span style={{ ...chipField, color: open ? "var(--text)" : "var(--muted)" }}>
          {field.icon}
          {field.label}
        </span>
        <span
          style={{
            padding: "0 8px",
            fontSize: "var(--text-meta)",
            color: "var(--muted)",
            borderLeft: "1px solid var(--edge)",
            borderRight: "1px solid var(--edge)",
            height: "100%",
            display: "flex",
            alignItems: "center",
          }}
        >
          {field.multi ? "any" : "is"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: "var(--text-body)" }}>
          {icons.length > 0 && (
            <span style={{ display: "flex" }}>
              {icons.map((o, i) => (
                <span
                  key={o.value}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "var(--ink)",
                    border: "1px solid var(--edge)",
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
      </PopoverTrigger>
      <Button variant="ghost" onClick={onClear} aria-label={`Clear ${field.label} filter`} className="filter-chip-clear">
        <ChipX />
      </Button>
    </span>
  );
}

/* -------------------------------------------------------------- menu --- */

/**
 * The menu surface, anchored under whatever trigger opened it.
 *
 * It is as wide as its longest row, so "Web pages & bookmarks" is never cut,
 * and never narrower than its trigger or wider than the screen. Focus moves
 * into it only for keyboard opens (or to a search field): a pointer open
 * leaves the first row alone, so no ring appears that the pointer did not
 * ask for.
 */
function FilterMenuContent({
  children,
  align = "start",
  searchable = false,
  anchor,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  searchable?: boolean;
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <PopoverContent
      align={align}
      anchor={anchor}
      sideOffset={6}
      initialFocus={(type) => searchable || type === "keyboard"}
      className="filter-menu"
    >
      {children}
    </PopoverContent>
  );
}

/** The value rows of a filter menu; exported for tests. */
export function ValueList({
  field,
  values,
  onToggle,
  onClear,
  onBack,
}: {
  field: Field;
  values: string[];
  onToggle: (field: Field, value: string) => void;
  onClear: () => void;
  /** Present when this list was opened from the field list. */
  onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [queryField, setQueryField] = useState(field.key);
  if (queryField !== field.key) {
    setQueryField(field.key);
    setQuery("");
  }
  const valuesSet = useMemo(() => new Set(values), [values]);

  const needle = query.toLowerCase();
  const shown = field.options.filter(
    (o) => needle === "" || o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
  );
  const withIcons = field.options.some((o) => o.icon);
  const withCounts = field.options.some((o) => o.count !== undefined);

  return (
    <>
      {onBack && (
        <Button variant="ghost" onClick={onBack} className="filter-menu-back">
          <Icon d="M15 6l-6 6 6 6" />
          {field.label}
        </Button>
      )}

      {field.searchable && (
        <div className="filter-menu-search">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={field.searchable}
            aria-label={field.searchable.replace(/…$/, "")}
          />
        </div>
      )}

      <div
        className="filter-menu-list scroll"
        role="group"
        aria-label={field.label}
        data-icons={withIcons || undefined}
        data-counts={withCounts || undefined}
      >
        {shown.length === 0 && <p className="filter-menu-empty">Nothing matches</p>}
        {shown.map((option) => {
          const on = valuesSet.has(option.value);
          return (
            <label key={option.value} className="filter-option" data-checked={on || undefined}>
              <Checkbox
                checked={on}
                onCheckedChange={() => onToggle(field, option.value)}
                className={field.multi ? undefined : "rounded-full"}
              />
              {withIcons && <span className="filter-menu-icon">{option.icon}</span>}
              <span className="filter-option-label">{option.label}</span>
              {withCounts && (
                <span className="filter-option-count">
                  {option.count === undefined ? "" : formatCount(option.count)}
                </span>
              )}
            </label>
          );
        })}
      </div>

      {values.length > 0 && (
        <div className="filter-menu-foot">
          <span>{values.length} selected</span>
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        </div>
      )}
    </>
  );
}
