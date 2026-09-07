import type { SearchHit } from "@anansi/db";
import { useEffect, useRef, useState } from "react";
import { api, shortDate, sourceLabel, type ItemQuery } from "../lib/api.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { Bone, PaletteResultsSkeleton, useSlowLoad } from "./skeleton.tsx";
import { SourceMark } from "./sourcemark.tsx";

export function Palette({ open, onClose, onOpen, onSearch, total, filters }: {
  open: boolean;
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
  onSearch: (query: string) => void;
  total: number;
  filters: ItemQuery;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useDialogFocus(open, dialog, input, onClose);
  const slow = useSlowLoad(loading);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (!term) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      api.search(term, { ...filters, cursor: null, limit: 8 }, controller.signal)
        .then((result) => {
          setHits(result.items);
          setCursor(0);
        })
        .catch((reason: Error) => {
          if (reason.name !== "AbortError") {
            setHits([]);
            setError(reason.message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, open, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((value) => Math.min(value + 1, Math.max(0, hits.length - 1)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter" && hits[cursor]) {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) window.open(hits[cursor]!.url, "_blank", "noopener");
        else onOpen(hits[cursor]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, hits, onOpen, open]);

  if (!open) return null;
  const term = query.trim();

  return (
    <div onMouseDown={(event) => event.target === event.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "#06080ac7", zIndex: 50, animation: "rise 120ms ease-out both" }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="search-title" tabIndex={-1} style={{ position: "absolute", left: "50%", top: 92, transform: "translateX(-50%)", width: 760, maxWidth: "calc(100vw - 32px)", background: "#10151a", border: "1px solid var(--edge-strong)", borderRadius: 10, boxShadow: "0 24px 60px -12px #000000b3", overflow: "hidden", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 17px", borderBottom: "1px solid var(--line)" }}>
          <SourceMark source="web" size={17} />
          <label id="search-title" htmlFor="library-search" className="sr-only">Search library</label>
          <input ref={input} id="library-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${total.toLocaleString()} saved items`} style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 16, color: "var(--text)", fontFamily: "var(--sans)" }} />
          <button type="button" onClick={onClose} aria-label="Close search" style={quietButton}>esc</button>
        </div>
        <div className="mono" aria-live="polite" style={{ display: "flex", alignItems: "center", padding: "9px 17px", borderBottom: "1px solid var(--line)", background: "#0e1317", fontSize: 10.5, color: "var(--faint)" }}>
          {term ? (loading ? slow ? <Bone width={72} height={8} /> : null : error ? "Search failed" : `${hits.length}${hits.length === 8 ? "+" : ""} quick result${hits.length === 1 ? "" : "s"}`) : "Type to search"}
          <span style={{ marginLeft: "auto" }}>{hasFilters(filters) ? "within current filters" : "across your library"}</span>
        </div>
        <div className="scroll" style={{ maxHeight: 420 }}>
          {error && <div role="alert" style={{ padding: 18, color: "#f2a7a7", fontSize: 13 }}>{error}<button type="button" onClick={() => setQuery(`${term} `)} style={{ ...quietButton, marginLeft: 10 }}>Retry</button></div>}
          {loading && slow ? <PaletteResultsSkeleton /> : !error && hits.map((hit, index) => (
            <button key={hit.id} type="button" onMouseEnter={() => setCursor(index)} onClick={() => onOpen(hit)} style={{ display: "flex", gap: 13, padding: "13px 17px", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", background: index === cursor ? "#161c22" : "transparent", borderLeft: `2px solid ${index === cursor ? "var(--accent)" : "transparent"}`, borderTop: index ? "1px solid #161c22" : "none", borderRight: "none", borderBottom: "none" }}>
              <span style={{ width: 26, height: 26, display: "grid", placeItems: "center", flexShrink: 0 }}><SourceMark source={hit.source} size={17} /></span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{hit.title ?? hit.authorName ?? hit.author ?? "Untitled save"}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{sourceLabel(hit.source)}{hit.postedAt ? ` · ${shortDate(hit.postedAt)}` : ""}</span>
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-dim)" }}>{hit.excerpt}</span>
              </span>
            </button>
          ))}
          {!loading && !error && term && hits.length === 0 && <div style={{ padding: "22px 17px", color: "var(--muted)", fontSize: 13.5, lineHeight: 1.5 }}>No results for <span className="mono" style={{ color: "var(--text)" }}>{term}</span> in this view.<div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 4 }}>Try one broader term or clear a filter.</div></div>}
        </div>
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 17px", borderTop: "1px solid var(--line)", background: "#0e1317", fontSize: 10, color: "var(--faint)" }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>⌘↵ open source</span>
          {term && <button type="button" onClick={() => onSearch(term)} style={{ ...quietButton, marginLeft: "auto", color: "var(--accent)" }}>View all results →</button>}
        </div>
      </div>
    </div>
  );
}

function hasFilters(filters: ItemQuery): boolean {
  return !!(filters.source?.length || filters.author?.length || filters.type?.length || filters.tag?.length || filters.media || filters.archived || filters.favorite || filters.removed);
}

const quietButton = { background: "transparent", border: "none", color: "var(--faint)", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5 } as const;
