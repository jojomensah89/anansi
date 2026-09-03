import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@anansi/db";
import { api, shortDate } from "../lib/api.ts";

/**
 * The search palette.
 *
 * The canvas note on the Search artboard is the design brief: "Search is the
 * product surface, not the grid." So it is an overlay over the library rather
 * than a route you navigate to — searching should never cost you your place.
 *
 * The score column is real bm25: negative, and lower is better. It is shown
 * because when a result looks wrong the score is the first thing that
 * explains why.
 */
export function Palette({
  open,
  onClose,
  onOpen,
  total,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
  total: number;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (!term) {
      setHits([]);
      setElapsed(null);
      return;
    }
    // Debounced and abortable: typing a word should not leave eight in-flight
    // requests racing to render out of order.
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => {
      api
        .search(term, { limit: 8 }, controller.signal)
        .then((r) => {
          setHits(r.results);
          setCursor(0);
          setElapsed(Math.round(performance.now() - started));
        })
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, hits.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (e.key === "Enter" && hits[cursor]) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) window.open(hits[cursor]!.url, "_blank", "noopener");
        else onOpen(hits[cursor]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hits, cursor, onClose, onOpen]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "#06080ac7",
        zIndex: 50,
        animation: "rise 120ms ease-out both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: "50%",
          top: 92,
          transform: "translateX(-50%)",
          width: 760,
          maxWidth: "calc(100vw - 32px)",
          background: "#10151a",
          border: "1px solid var(--edge-strong)",
          borderRadius: 10,
          boxShadow: "0 24px 60px -12px #000000b3",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "15px 17px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${total.toLocaleString()} saves`}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 16,
              color: "var(--text)",
              fontFamily: "var(--sans)",
            }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fainter)" }}>
            esc to close
          </span>
        </div>

        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 17px",
            borderBottom: "1px solid var(--line)",
            background: "#0e1317",
            fontSize: 10.5,
            color: "var(--faint)",
          }}
        >
          <span>fts5 · porter unicode61</span>
          <span style={{ marginLeft: "auto" }}>
            {query.trim()
              ? `${hits.length} result${hits.length === 1 ? "" : "s"}${elapsed !== null ? ` · ${elapsed} ms` : ""}`
              : "type to search"}
          </span>
        </div>

        <div className="scroll" style={{ maxHeight: 420 }}>
          {hits.map((hit, i) => (
            <button
              key={hit.id}
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => onOpen(hit)}
              style={{
                display: "flex",
                gap: 13,
                padding: "13px 17px",
                width: "100%",
                textAlign: "left",
                font: "inherit",
                color: "inherit",
                cursor: "pointer",
                background: i === cursor ? "#161c22" : "transparent",
                borderLeft: `2px solid ${i === cursor ? "var(--accent)" : "transparent"}`,
                borderTop: i ? "1px solid #161c22" : "none",
                borderRight: "none",
                borderBottom: "none",
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: hit.source === "github" ? 4 : "50%",
                  background: "var(--edge-strong)",
                  flexShrink: 0,
                  marginTop: 1,
                }}
              />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {hit.author ?? "unknown"}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
                    {shortDate(hit.postedAt)}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: "var(--faint)",
                      border: "1px solid var(--edge)",
                      borderRadius: 3,
                      padding: "1px 4px",
                    }}
                  >
                    {hit.source === "github" ? "gh" : "x"}
                  </span>
                  <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>
                    {hit.score.toFixed(2)}
                  </span>
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-dim)" }}>{hit.excerpt}</span>
              </span>
            </button>
          ))}

          {query.trim() && hits.length === 0 && (
            <div style={{ padding: "22px 17px", color: "var(--muted)", fontSize: 13.5, lineHeight: 1.5 }}>
              Nothing matches{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {query.trim()}
              </span>
              .
              {/* The honest failure mode: bm25 has no notion of near. */}
              <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 4 }}>
                Keyword search needs the exact word — try a correction, or one broader term.
              </div>
            </div>
          )}
        </div>

        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "9px 17px",
            borderTop: "1px solid var(--line)",
            background: "#0e1317",
            fontSize: 10,
            color: "var(--faint)",
          }}
        >
          <Key k="↑↓" label="navigate" />
          <Key k="↵" label="open" />
          <Key k="⌘↵" label="open on x.com" />
        </div>
      </div>
    </div>
  );
}

function Key({ k, label }: { k: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span style={{ border: "1px solid var(--edge-strong)", borderRadius: 3, padding: "1px 4px" }}>{k}</span>
      {label}
    </span>
  );
}
